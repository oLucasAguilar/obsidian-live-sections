'use strict';

const obsidian = require('obsidian');
const { Decoration, EditorView, ViewPlugin, WidgetType, keymap } = require('@codemirror/view');
const { Prec, StateEffect, StateField } = require('@codemirror/state');

function splitLinkText(raw) {
  let alias = null;
  let target = raw;
  const pipe = target.indexOf('|');
  if (pipe >= 0) {
    alias = target.slice(pipe + 1).trim();
    target = target.slice(0, pipe);
  }
  const hash = target.indexOf('#');
  const path = (hash === -1 ? target : target.slice(0, hash)).trim();
  const rest = hash === -1 ? '' : target.slice(hash + 1);
  const segments = rest
    .split('#')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const isBlockRef = segments.length > 0 && segments[segments.length - 1].startsWith('^');
  return { path, segments, alias, isBlockRef, subpath: segments.join('#') };
}

function normalizeHeading(text) {
  return String(text)
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (m, p, a) => a || p)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .normalize('NFC')
    .toLowerCase();
}

function parseHeadings(text) {
  const lines = text.split('\n');
  const headings = [];
  let fenceChar = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fence) {
      const char = fence[1][0];
      if (fenceChar === null) fenceChar = char;
      else if (fenceChar === char) fenceChar = null;
      continue;
    }
    if (fenceChar !== null) continue;
    const m = line.match(/^(#{1,6})\s+(.*?)\s*$/);
    if (m) {
      headings.push({ index: headings.length, line: i, level: m[1].length, text: m[2], key: normalizeHeading(m[2]) });
    }
  }
  return { lines, headings };
}

function findSection(text, segments) {
  if (!segments || segments.length === 0) return null;
  const { lines, headings } = parseHeadings(text);
  let searchFrom = 0;
  let windowEnd = headings.length;
  let parentLevel = 0;
  let found = null;

  for (const segment of segments) {
    const key = normalizeHeading(segment);
    let hit = -1;
    for (let i = searchFrom; i < windowEnd; i++) {
      if (headings[i].level > parentLevel && headings[i].key === key) {
        hit = i;
        break;
      }
    }
    if (hit === -1) return null;
    found = headings[hit];
    let nextEnd = windowEnd;
    for (let i = hit + 1; i < windowEnd; i++) {
      if (headings[i].level <= found.level) {
        nextEnd = i;
        break;
      }
    }
    searchFrom = hit + 1;
    windowEnd = nextEnd;
    parentLevel = found.level;
  }

  const bodyEnd = windowEnd < headings.length ? headings[windowEnd].line : lines.length;
  return {
    headingLine: found.line,
    headingText: found.text,
    level: found.level,
    bodyStart: found.line + 1,
    bodyEnd,
    body: lines.slice(found.line + 1, bodyEnd).join('\n'),
  };
}

function splitTrailingBlank(text) {
  const match = /(\n[ \t]*)+$/.exec(text);
  if (!match) return { text, trailing: '' };
  return { text: text.slice(0, match.index), trailing: match[0] };
}

function replaceSection(text, segments, newBody) {
  const section = findSection(text, segments);
  if (!section) return null;
  const lines = text.split('\n');
  const head = lines.slice(0, section.bodyStart);
  const tail = lines.slice(section.bodyEnd);
  return head.concat(newBody.split('\n'), tail).join('\n');
}

function breadcrumbParts(path, segments) {
  const parts = [];
  if (path) parts.push(path.split('/').pop().replace(/\.md$/i, ''));
  for (const segment of segments) parts.push(segment.replace(/^\^/, ''));
  return parts;
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function embedLineRegex(trigger) {
  return new RegExp(`^(\\s*(?:[-*+]\\s+|\\d+\\.\\s+)?)${escapeRegExp(trigger)}\\[\\[([^\\]\\n]+)\\]\\]\\s*$`);
}

// Block only when the trigger is alone at the start of its line, mirroring
// Obsidian's own embeds. Inline keeps the line's indentation.
function triggerPlacement(lineText, embedRegex) {
  const match = lineText.match(embedRegex);
  if (!match) return null;
  const prefix = match[1] || '';
  return { prefix, linktext: match[2], block: prefix.length === 0 };
}

function indentWidth(text) {
  const lead = (text.match(/^[ \t]*/) || [''])[0];
  return lead.replace(/\t/g, '    ').length;
}

function hasIndentedChild(lineTexts, lineNumber) {
  const own = indentWidth(lineTexts[lineNumber - 1] || '');
  for (let i = lineNumber; i < lineTexts.length; i++) {
    if (!lineTexts[i].trim()) continue;
    return indentWidth(lineTexts[i]) > own;
  }
  return false;
}

function collapseKeyFor(sourcePath, linktext, occurrence) {
  return `${sourcePath}::${linktext}::${occurrence || 0}`;
}

function buildOccurrenceMap(lineTexts, embedRegex) {
  const counts = new Map();
  const byLine = new Map();
  for (let i = 0; i < lineTexts.length; i++) {
    const placement = triggerPlacement(lineTexts[i], embedRegex);
    if (!placement) continue;
    const seen = counts.get(placement.linktext) || 0;
    byLine.set(i + 1, seen);
    counts.set(placement.linktext, seen + 1);
  }
  return byLine;
}

function stepTargetLine(lineTexts, currentNumber, dir, embedRegex) {
  const targetNumber = currentNumber + dir;
  if (targetNumber < 1 || targetNumber > lineTexts.length) return null;
  return embedRegex.test(lineTexts[targetNumber - 1]) ? targetNumber : null;
}

function skipTargetLine(lineTexts, currentNumber, dir, embedRegex) {
  if (stepTargetLine(lineTexts, currentNumber, dir, embedRegex) === null) return null;
  let n = currentNumber + dir;
  while (n >= 1 && n <= lineTexts.length && embedRegex.test(lineTexts[n - 1])) n += dir;
  if (n < 1 || n > lineTexts.length) {
    return dir < 0 ? 1 : lineTexts.length;
  }
  return n;
}

function resolveLink(app, linktext, sourcePath) {
  const parsed = splitLinkText(linktext);
  if (!parsed.path) {
    return { parsed, file: app.vault.getAbstractFileByPath(sourcePath), reason: null };
  }
  const file = app.metadataCache.getFirstLinkpathDest(parsed.path, sourcePath);
  return { parsed, file, reason: file ? null : `no note matches "${parsed.path}"` };
}

function openLinkTarget(app, linktext, sourcePath, newLeaf) {
  const { file, reason } = resolveLink(app, linktext, sourcePath);
  if (!file) {
    new obsidian.Notice(`Live Sections: ${reason} (linked from ${sourcePath})`, 6000);
    return;
  }
  Promise.resolve(app.workspace.openLinkText(linktext, sourcePath, newLeaf)).catch((err) => {
    console.error('[live-sections] openLinkText failed', linktext, err);
    new obsidian.Notice(`Live Sections: could not open ${file.path}`, 6000);
  });
}

function wireLink(app, el, linktext, sourcePath, options) {
  const opts = options || {};

  el.addEventListener('mousedown', (event) => {
    if (event.button === 1) event.preventDefault();
  });
  el.addEventListener('auxclick', (event) => {
    if (event.button !== 1) return;
    event.preventDefault();
    event.stopPropagation();
    openLinkTarget(app, linktext, sourcePath, 'tab');
  });

  el.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const mod = obsidian.Keymap ? obsidian.Keymap.isModEvent(event) : false;
    if (!mod && opts.onPlainClick) {
      opts.onPlainClick(event);
      return;
    }
    openLinkTarget(app, linktext, sourcePath, mod);
  });
  el.addEventListener('mouseover', (event) => {
    app.workspace.trigger('hover-link', {
      event,
      source: 'editor',
      hoverParent: { hoverPopover: null },
      targetEl: el,
      linktext,
      sourcePath,
    });
  });
}

function renderBreadcrumb(container, parts) {
  parts.forEach((part, i) => {
    if (i > 0) {
      const sep = container.createSpan({ cls: 'live-sections-sep' });
      sep.setText('>');
    }
    const chunk = container.createSpan({ cls: i === 0 ? 'live-sections-file' : 'live-sections-head' });
    chunk.setText(part);
  });
}

let embeddedEditorCtor;

function getEmbeddedEditorCtor(app) {
  if (embeddedEditorCtor !== undefined) return embeddedEditorCtor;
  embeddedEditorCtor = null;
  try {
    const container = document.createElement('div');
    const probe = app.embedRegistry.embedByExtension.md({ app, containerEl: container }, null, '');
    probe.editable = true;
    probe.showEditor();
    const proto = Object.getPrototypeOf(Object.getPrototypeOf(probe.editMode));
    probe.unload();
    container.remove();
    if (proto && typeof proto.constructor === 'function') embeddedEditorCtor = proto.constructor;
  } catch (err) {
    console.error('[live-sections] native embedded editor unavailable, falling back', err);
    embeddedEditorCtor = null;
  }
  return embeddedEditorCtor;
}

let sectionEditorClass;

function getSectionEditorClass(app) {
  if (sectionEditorClass !== undefined) return sectionEditorClass;
  const Base = getEmbeddedEditorCtor(app);
  if (!Base) {
    sectionEditorClass = null;
    return null;
  }
  sectionEditorClass = class SectionEditor extends Base {
    constructor(theApp, containerEl, options) {
      // Obsidian treats this as the active editor while the box has focus, and
      // every editor command reads owner.editor off it
      const self = { app: theApp, onMarkdownScroll() {}, getMode: () => 'source' };
      let created = null;
      Object.defineProperty(self, 'editor', { get: () => (created ? created.editor : undefined) });
      Object.defineProperty(self, 'file', { get: () => (options && options.file) || null });
      Object.defineProperty(self, 'path', {
        get: () => (options && options.file ? options.file.path : ''),
      });
      super(theApp, containerEl, self);
      created = this;
      this.owner = self;
      this.options = options;
      this.set(options.value || '', true);
    }

    get currentValue() {
      return this.editor ? this.editor.getValue() : '';
    }

    onUpdate(update, changed) {
      super.onUpdate(update, changed);
      if (changed && this.options.onChange) this.options.onChange(this.currentValue);
    }
  };
  return sectionEditorClass;
}

class SectionEditorHost {
  constructor(app, containerEl, options) {
    this.app = app;
    this.options = options;
    this.mode = 'native';
    const Cls = getSectionEditorClass(app);
    if (Cls) {
      try {
        this.native = new Cls(app, containerEl, options);
      } catch (err) {
        console.error('[live-sections] native editor construction failed, falling back', err);
        this.native = null;
      }
    }
    if (!this.native) {
      this.mode = 'fallback';
      this.view = new EditorView({
        doc: options.value || '',
        parent: containerEl,
        extensions: [
          EditorView.lineWrapping,
          EditorView.updateListener.of((update) => {
            if (update.docChanged && options.onChange) options.onChange(this.getValue());
          }),
        ],
      });
    }
  }

  getValue() {
    if (this.native) return this.native.currentValue;
    return this.view.state.doc.toString();
  }

  setValue(value) {
    if (value === this.getValue()) return;
    if (this.native) {
      this.native.set(value, true);
      return;
    }
    this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: value } });
  }

  owner() {
    return (this.native && this.native.owner) || null;
  }

  obsidianEditor() {
    return (this.native && this.native.editor) || null;
  }

  cmView() {
    if (this.native) return (this.native.editor && this.native.editor.cm) || null;
    return this.view || null;
  }

  hasFocus() {
    const cm = this.cmView();
    return !!(cm && cm.hasFocus);
  }

  focusEdge(dir, column) {
    const cm = this.cmView();
    if (!cm) return false;
    const line = cm.state.doc.line(dir === 1 ? 1 : cm.state.doc.lines);
    cm.dispatch({
      selection: { anchor: Math.min(line.from + column, line.to) },
      scrollIntoView: true,
    });
    cm.focus();
    return true;
  }

  destroy() {
    try {
      if (this.native) this.native.destroy();
      else this.view.destroy();
    } catch (err) {
      console.error('[live-sections] editor teardown failed', err);
    }
  }
}

class SectionMount {
  constructor(plugin, linktext, sourcePath, view, isInline, preview, occurrence, collapsible) {
    this.plugin = plugin;
    this.app = plugin.app;
    this.linktext = linktext;
    this.sourcePath = sourcePath;
    this.view = view;
    this.parsed = splitLinkText(linktext);
    this.writing = false;
    this.destroyed = false;
    this.el = document.createElement('div');
    this.preview = !!preview;
    this.occurrence = occurrence || 0;
    this.collapsible = collapsible !== false;
    this.el.className =
      'live-sections-embed ' + (isInline ? 'is-inline' : 'is-block') + (preview ? ' is-preview' : '');
    this.el.__liveSectionsMount = this;

    this.el.addEventListener('mousedown', (event) => event.stopPropagation());

    window.requestAnimationFrame(() => {
      this.hideTrailingBuffers();
      this.bindMarker();
      this.watchBuffers();
    });

    this.el.addEventListener('focusin', () => this.plugin.refreshEditors());
    this.el.addEventListener('focusout', (event) => {
      if (event.relatedTarget && this.el.contains(event.relatedTarget)) return;
      this.releaseEditorContext();
      this.plugin.refreshEditors();
    });

    this.headerEl = this.el.createDiv({ cls: 'live-sections-embed-header' });
    this.bodyEl = this.el.createDiv({ cls: 'live-sections-embed-body' });

    this.onVaultModify = (file) => {
      if (!this.targetFile || file.path !== this.targetFile.path) return;
      if (this.writing) return;
      this.refreshFromDisk();
    };
    this.modifyRef = this.app.vault.on('modify', this.onVaultModify);

    this.flush = obsidian.debounce(
      (value) => {
        this.writeBack(value);
      },
      this.plugin.settings.writeDelayMs,
      true
    );

    this.render();
  }

  resolveTarget() {
    const path = this.parsed.path;
    if (!path) return this.app.vault.getAbstractFileByPath(this.sourcePath);
    return this.app.metadataCache.getFirstLinkpathDest(path, this.sourcePath);
  }

  get collapseKey() {
    return collapseKeyFor(this.sourcePath, this.linktext, this.occurrence);
  }

  get collapsed() {
    return this.collapsible && this.plugin.collapsed.has(this.collapseKey);
  }

  applyCollapsed() {
    this.el.classList.toggle('is-collapsed', this.collapsed);
  }

  toggleCollapsed() {
    this.plugin.toggleCollapsedKey(this.collapseKey);
  }

  renderHeader() {
    this.headerEl.empty();
    if (this.preview) return;

    const crumb = this.headerEl.createSpan({ cls: 'live-sections-breadcrumb is-embed-title' });
    crumb.setAttribute('data-href', this.linktext);
    const marker = crumb.createSpan({ cls: 'live-sections-at' });
    marker.setText('@');
    marker.setAttribute('title', 'Click to edit this link');
    marker.addEventListener('mousedown', (event) => event.preventDefault());
    marker.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.revealTriggerLine();
    });
    renderBreadcrumb(crumb, breadcrumbParts(this.parsed.path, this.parsed.segments));
    crumb.setAttribute('title', 'Click to open, ctrl or middle click to open in a tab. Click the @ to edit the link.');
    wireLink(this.app, crumb, this.linktext, this.sourcePath);
    if (this.host && this.host.mode === 'fallback') {
      const warn = this.headerEl.createSpan({ cls: 'live-sections-warn' });
      warn.setText('plain editor fallback');
      warn.setAttribute('title', 'Obsidian internal editor could not be used here, so this box has no live preview or hotkeys. Content still syncs.');
    }
  }

  revealTriggerLine(column) {
    if (!this.view) return;
    try {
      const pos = this.view.posAtDOM(this.el);
      const line = this.view.state.doc.lineAt(pos);
      const anchor = column ? Math.min(line.from + column, line.to) : line.from;
      this.view.dispatch({ selection: { anchor }, scrollIntoView: true });
      this.view.focus();
    } catch (err) {
      console.error('[live-sections] could not reveal the trigger line', err);
    }
  }

  hideTrailingBuffers() {
    if (this.destroyed || !this.el.isConnected) return;
    for (let node = this.el.nextElementSibling; node; node = node.nextElementSibling) {
      if (!node.classList || !node.classList.contains('cm-widgetBuffer')) break;
      // important, or Obsidian's own !important rule on the buffer wins
      node.style.setProperty('display', 'none', 'important');
    }
  }

  releaseEditorContext() {
    const workspace = this.app.workspace;
    const owner = this.host && this.host.owner();
    if (!owner || workspace.activeEditor !== owner) return;
    try {
      workspace.activeEditor = workspace.getActiveViewOfType(obsidian.MarkdownView) || null;
    } catch (err) {
      console.error('[live-sections] could not release the editor context', err);
    }
  }

  markerEl() {
    let node = this.el.previousElementSibling;
    while (node && node.classList && node.classList.contains('cm-widgetBuffer')) {
      node = node.previousElementSibling;
    }
    if (!node || !node.classList || !node.classList.contains('cm-formatting-list')) return null;
    return node;
  }

  bindMarker() {
    const marker = this.markerEl();
    if (!marker || marker.__liveSectionsBound) return;
    marker.__liveSectionsBound = true;
    marker.addEventListener('mousedown', (event) => event.preventDefault());
    marker.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.toggleCollapsed();
    });
  }

  watchBuffers() {
    if (this.destroyed || this.bufferObserver) return;
    const parent = this.el.parentElement;
    if (!parent || typeof MutationObserver === 'undefined') return;
    this.bufferObserver = new MutationObserver(() => {
      this.hideTrailingBuffers();
      this.bindMarker();
    });
    this.bufferObserver.observe(parent, { childList: true });
  }

  triggerLine() {
    if (!this.view) return null;
    try {
      return this.view.state.doc.lineAt(this.view.posAtDOM(this.el));
    } catch (err) {
      return null;
    }
  }

  exitTo(dir, column, skipBlock) {
    const line = this.triggerLine();
    if (!line) return;
    const doc = this.view.state.doc;
    let targetNumber = line.number + dir;
    if (skipBlock) {
      const lineTexts = [];
      for (let n = 1; n <= doc.lines; n++) lineTexts.push(doc.line(n).text);
      const skipped = skipTargetLine(lineTexts, line.number, dir, this.plugin.embedLine);
      if (skipped !== null) targetNumber = skipped;
    }
    if (targetNumber < 1 || targetNumber > doc.lines) {
      this.revealTriggerLine();
      return;
    }
    const target = doc.line(targetNumber);
    this.view.dispatch({
      selection: { anchor: Math.min(target.from + column, target.to) },
      scrollIntoView: true,
    });
    this.view.focus();
  }

  attachKeyboardBridge() {
    this.bodyEl.addEventListener('keydown', (event) => {
      if (this.destroyed) return;

      if (event.key === 'Escape') {
        if (event.defaultPrevented) return;
        event.preventDefault();
        event.stopPropagation();
        this.revealTriggerLine();
        return;
      }

      const dir = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
      if (dir === 0) return;

      const cm = this.host && this.host.cmView();
      if (!cm) return;
      const cursor = cm.state.selection.main;
      if (!cursor.empty) return;
      const line = cm.state.doc.lineAt(cursor.head);
      const column = cursor.head - line.from;

      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        event.stopPropagation();
        this.exitTo(dir, column, true);
        return;
      }

      if (!this.plugin.settings.exitOnPlainArrow) return;
      const atEdge = dir === -1 ? line.number === 1 : line.number === cm.state.doc.lines;
      if (!atEdge) return;
      event.preventDefault();
      event.stopPropagation();
      if (dir === -1) this.revealTriggerLine(column);
      else this.exitTo(1, column, false);
    }, true);
  }

  focusEdge(dir, column) {
    if (this.destroyed || !this.host || this.collapsed) return false;
    return this.host.focusEdge(dir, column);
  }

  renderError(message) {
    this.bodyEl.empty();
    const err = this.bodyEl.createDiv({ cls: 'live-sections-error' });
    err.setText(message);
  }

  async render() {
    const file = this.resolveTarget();
    if (!file) {
      this.renderHeader();
      this.renderError(`Note not found: ${this.parsed.path}`);
      return;
    }
    if (file.path === this.sourcePath && this.parsed.segments.length === 0) {
      this.renderHeader();
      this.renderError('Refusing to embed the same note into itself.');
      return;
    }
    this.targetFile = file;

    let text;
    try {
      text = await this.app.vault.cachedRead(file);
    } catch (err) {
      this.renderHeader();
      this.renderError(`Could not read ${file.path}`);
      return;
    }
    if (this.destroyed) return;

    if (this.parsed.isBlockRef) {
      this.renderHeader();
      this.renderError('Block references are not supported yet, use a heading.');
      return;
    }

    const section = this.parsed.segments.length ? findSection(text, this.parsed.segments) : null;
    if (this.parsed.segments.length && !section) {
      this.renderHeader();
      this.renderError(`Heading not found: ${this.parsed.segments.join(' > ')}`);
      return;
    }

    const split = splitTrailingBlank(section ? section.body : text);
    this.trailingBlank = split.trailing;
    const value = split.text;
    this.bodyEl.empty();
    this.host = new SectionEditorHost(this.app, this.bodyEl, {
      value,
      file,
      onChange: (next) => this.flush(next),
    });
    this.attachKeyboardBridge();
    this.renderHeader();
    this.applyCollapsed();
  }

  async refreshFromDisk() {
    if (!this.targetFile || !this.host || this.destroyed) return;
    if (this.host.hasFocus()) return;
    const text = await this.app.vault.cachedRead(this.targetFile);
    const section = this.parsed.segments.length ? findSection(text, this.parsed.segments) : null;
    if (this.parsed.segments.length && !section) {
      this.renderError(`Heading not found: ${this.parsed.segments.join(' > ')}`);
      return;
    }
    const refreshed = splitTrailingBlank(section ? section.body : text);
    this.trailingBlank = refreshed.trailing;
    this.host.setValue(refreshed.text);
  }

  async writeBack(value) {
    if (!this.targetFile || this.destroyed) return;
    this.writing = true;
    try {
      const body = splitTrailingBlank(value).text + (this.trailingBlank || '');
      await this.app.vault.process(this.targetFile, (data) => {
        if (!this.parsed.segments.length) return body;
        const next = replaceSection(data, this.parsed.segments, body);
        return next === null ? data : next;
      });
    } catch (err) {
      console.error('[live-sections] write back failed', err);
      new obsidian.Notice(`Live Sections: could not write to ${this.targetFile.path}`);
    } finally {
      window.setTimeout(() => {
        this.writing = false;
      }, 50);
    }
  }

  destroy() {
    this.destroyed = true;
    if (this.bufferObserver) this.bufferObserver.disconnect();
    if (this.modifyRef) this.app.vault.offref(this.modifyRef);
    if (this.host) this.host.destroy();
  }
}

class SectionWidget extends WidgetType {
  constructor(plugin, linktext, sourcePath, isInline, preview, occurrence, collapsible) {
    super();
    this.plugin = plugin;
    this.linktext = linktext;
    this.sourcePath = sourcePath;
    this.isInline = !!isInline;
    this.preview = !!preview;
    this.occurrence = occurrence || 0;
    this.collapsible = collapsible !== false;
  }

  eq(other) {
    return (
      other.linktext === this.linktext &&
      other.sourcePath === this.sourcePath &&
      other.isInline === this.isInline &&
      other.preview === this.preview &&
      other.occurrence === this.occurrence &&
      other.collapsible === this.collapsible
    );
  }

  toDOM(view) {
    const mount = new SectionMount(
      this.plugin, this.linktext, this.sourcePath, view, this.isInline, this.preview,
      this.occurrence, this.collapsible
    );
    this.plugin.mounts.add(mount);
    return mount.el;
  }

  destroy(dom) {
    const mount = dom && dom.__liveSectionsMount;
    if (mount) {
      this.plugin.mounts.delete(mount);
      mount.destroy();
    }
  }

  ignoreEvent() {
    return true;
  }
}

class FoldWidget extends WidgetType {
  constructor(plugin, key, collapsed) {
    super();
    this.plugin = plugin;
    this.key = key;
    this.collapsed = !!collapsed;
  }

  eq(other) {
    return other.key === this.key && other.collapsed === this.collapsed;
  }

  toDOM() {
    // on both: the rotation rule keys off the icon, the rest off the indicator
    const flag = this.collapsed ? ' is-collapsed' : '';
    const el = document.createElement('span');
    el.className = 'cm-fold-indicator live-sections-fold' + flag;
    const indicator = el.createDiv({ cls: 'collapse-indicator collapse-icon' + flag });
    indicator.setAttribute('title', 'Collapse or expand');
    if (obsidian.setIcon) obsidian.setIcon(indicator, 'right-triangle');
    indicator.addEventListener('mousedown', (event) => event.preventDefault());
    indicator.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.plugin.toggleCollapsedKey(this.key);
    });
    return el;
  }

  ignoreEvent() {
    return true;
  }
}

const refreshEffect = StateEffect.define();

function triggerRevealed(plugin, state, line) {
  if (plugin.focusedMount()) return false;
  return selectionTouches(state, line.from, line.to);
}

function selectionTouches(state, from, to) {
  for (const range of state.selection.ranges) {
    if (range.from <= to && range.to >= from) return true;
  }
  return false;
}

function fileFromState(state) {
  const field = obsidian.editorInfoField;
  if (!field) return null;
  const info = state.field(field, false);
  return info && info.file ? info.file : null;
}

function toDecorationSet(ranges) {
  ranges.sort((a, b) => a.from - b.from || a.value.startSide - b.value.startSide);
  return Decoration.set(ranges, true);
}

function guarded(label, fn) {
  try {
    return fn();
  } catch (err) {
    console.error(`[live-sections] ${label} failed, rendering nothing for this pass`, err);
    return Decoration.none;
  }
}

function makeCursorKeymap(plugin) {
  const context = (view) => {
    if (!plugin.settings.sectionEmbeds) return null;
    const state = view.state;
    const cursor = state.selection.main;
    if (!cursor.empty) return null;
    const current = state.doc.lineAt(cursor.head);
    const lineTexts = [];
    for (let n = 1; n <= state.doc.lines; n++) lineTexts.push(state.doc.line(n).text);
    return { state, cursor, current, lineTexts, column: cursor.head - current.from };
  };

  const moveTo = (view, lineNumber, column) => {
    const line = view.state.doc.line(lineNumber);
    view.dispatch({
      selection: { anchor: Math.min(line.from + column, line.to) },
      scrollIntoView: true,
    });
    return true;
  };

  const mountAtLine = (view, lineNumber) => {
    for (const mount of plugin.mounts) {
      if (mount.view !== view || mount.destroyed) continue;
      const line = mount.triggerLine();
      if (line && line.number === lineNumber) return mount;
    }
    return null;
  };

  const enter = (view, dir) => {
    const ctx = context(view);
    if (!ctx) return false;

    if (dir === 1 && plugin.embedLine.test(ctx.current.text)) {
      return stepFromTriggerIntoContent(view, ctx);
    }

    const targetNumber = stepTargetLine(ctx.lineTexts, ctx.current.number, dir, plugin.embedLine);
    if (targetNumber === null) return false;

    if (dir === 1) return moveTo(view, targetNumber, ctx.column);

    const mount = mountAtLine(view, targetNumber);
    if (mount && mount.focusEdge(dir, ctx.column)) return true;
    return moveTo(view, targetNumber, ctx.column);
  };

  const stepFromTriggerIntoContent = (view, ctx) => {
    const triggerNumber = ctx.current.number;
    const doc = view.state.doc;
    const parkNumber = Math.min(triggerNumber + 1, doc.lines);
    const park = doc.line(parkNumber);
    view.dispatch({ selection: { anchor: park.from }, scrollIntoView: true });
    window.requestAnimationFrame(() => {
      const mount = mountAtLine(view, triggerNumber);
      if (mount) mount.focusEdge(1, ctx.column);
    });
    return true;
  };

  const skip = (view, dir) => {
    const ctx = context(view);
    if (!ctx) return false;
    const targetNumber = skipTargetLine(ctx.lineTexts, ctx.current.number, dir, plugin.embedLine);
    if (targetNumber === null) return false;
    return moveTo(view, targetNumber, ctx.column);
  };

  return Prec.highest(
    keymap.of([
      { key: 'ArrowUp', run: (view) => enter(view, -1) },
      { key: 'ArrowDown', run: (view) => enter(view, 1) },
      { key: 'Mod-ArrowUp', run: (view) => skip(view, -1) },
      { key: 'Mod-ArrowDown', run: (view) => skip(view, 1) },
    ])
  );
}

function buildBlockDecorations(state, plugin) {
  const ranges = [];
  const doc = state.doc;
  const file = fileFromState(state);
  const sourcePath = file ? file.path : '';

  if (!plugin.settings.sectionEmbeds) return Decoration.none;

  const lineTexts = [];
  for (let n = 1; n <= doc.lines; n++) lineTexts.push(doc.line(n).text);
  const occurrences = buildOccurrenceMap(lineTexts, plugin.embedLine);

  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    const placement = triggerPlacement(line.text, plugin.embedLine);
    if (!placement) continue;
    const collapsible = !hasIndentedChild(lineTexts, n);

    if (triggerRevealed(plugin, state, line)) {
      ranges.push(
        Decoration.widget({
          widget: new SectionWidget(
            plugin, placement.linktext, sourcePath, placement.block === false, true,
            occurrences.get(n), collapsible
          ),
          side: 1,
        }).range(line.to)
      );
    } else if (placement.block) {
      ranges.push(
        Decoration.replace({
          widget: new SectionWidget(
            plugin, placement.linktext, sourcePath, false, false, occurrences.get(n), collapsible
          ),
          block: true,
        }).range(line.from, line.to)
      );
    }
  }

  return toDecorationSet(ranges);
}

function makeBlockField(plugin) {
  return StateField.define({
    create: (state) => guarded('block decorations', () => buildBlockDecorations(state, plugin)),
    update(value, tr) {
      const refreshed = tr.effects.some((effect) => effect.is(refreshEffect));
      if (tr.docChanged || tr.selection || refreshed) {
        return guarded('block decorations', () => buildBlockDecorations(tr.state, plugin));
      }
      return value;
    },
    provide: (field) => EditorView.decorations.from(field),
  });
}

function buildInlineDecorations(view, plugin) {
  const ranges = [];
  const state = view.state;
  const doc = state.doc;
  const file = fileFromState(state);
  const sourcePath = file ? file.path : '';

  if (!plugin.settings.sectionEmbeds) return Decoration.none;

  const lineTexts = doc.toString().split('\n');
  const occurrences = buildOccurrenceMap(lineTexts, plugin.embedLine);

  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = doc.lineAt(pos);
      const placement = triggerPlacement(line.text, plugin.embedLine);

      if (placement) {
        const key = collapseKeyFor(sourcePath, placement.linktext, occurrences.get(line.number));
        // A line with an indented line under it is a list item with children,
        // and Obsidian draws its own fold arrow there. Two arrows on one line
        // is one too many, so the native one owns that line.
        const collapsible = !hasIndentedChild(lineTexts, line.number);

        if (collapsible) {
          ranges.push(
            Decoration.widget({
              widget: new FoldWidget(plugin, key, plugin.collapsed.has(key)),
              side: -1,
            }).range(line.from)
          );
        }

        if (!placement.block && !triggerRevealed(plugin, state, line)) {
          ranges.push(
            Decoration.replace({
              widget: new SectionWidget(
                plugin, placement.linktext, sourcePath, true, false,
                occurrences.get(line.number), collapsible
              ),
            }).range(line.from + placement.prefix.length, line.to)
          );
        }
      }

      pos = line.to + 1;
    }
  }

  return toDecorationSet(ranges);
}

function makeViewPlugin(plugin) {
  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.decorations = guarded('inline decorations', () => buildInlineDecorations(view, plugin));
      }

      update(update) {
        const refreshed = update.transactions.some((tr) =>
          tr.effects.some((effect) => effect.is(refreshEffect))
        );
        if (update.docChanged || update.viewportChanged || update.selectionSet || refreshed) {
          this.decorations = guarded('inline decorations', () => buildInlineDecorations(update.view, plugin));
        }
        for (const mount of plugin.mounts) {
          if (mount.view === update.view) mount.hideTrailingBuffers();
        }
      }
    },
    {
      decorations: (value) => value.decorations,
    }
  );
}

const DEFAULT_SETTINGS = {
  sectionEmbeds: true,
  embedTrigger: '@',
  exitOnPlainArrow: true,
  writeDelayMs: 400,
};

class LiveSectionsPlugin extends obsidian.Plugin {
  async onload() {
    const data = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    this.collapsed = new Set(Array.isArray(data.collapsed) ? data.collapsed : []);
    this.saveCollapsed = obsidian.debounce(() => this.persist(), 500, true);
    this.mounts = new Set();
    this.embedLine = embedLineRegex(this.settings.embedTrigger);

    this.registerEditorExtension([
      Prec.highest(makeViewPlugin(this)),
      Prec.highest(makeBlockField(this)),
      makeCursorKeymap(this),
    ]);
    this.addSettingTab(new LiveSectionsSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(() => {
      this.refreshEditors();
      this.patchFoldCommand();
    });


    this.addCommand({
      id: 'toggle-live-section-embed',
      name: 'Toggle live section embed on the current line',
      editorCallback: (editor) => {
        const cursor = editor.getCursor();
        const line = editor.getLine(cursor.line);
        const trigger = this.settings.embedTrigger;
        if (this.embedLine.test(line)) {
          editor.setLine(cursor.line, line.replace(trigger + '[[', '[['));
        } else if (/\[\[[^\]\n]+\]\]/.test(line)) {
          editor.setLine(cursor.line, line.replace(/(!?)\[\[/, trigger + '[['));
        } else {
          new obsidian.Notice('No wikilink on this line.');
        }
      },
    });

    this.addCommand({
      id: 'toggle-section-collapse',
      name: 'Collapse or expand the live section at the cursor',
      editorCheckCallback: (checking, editor, ctx) => {
        const mount = this.mountAtCursor(editor, ctx);
        if (!mount) return false;
        if (!checking) mount.toggleCollapsed();
        return true;
      },
    });

    this.addCommand({
      id: 'report-section-layout',
      name: 'Report live section box layout',
      callback: () => {
        const describe = (el, label) => {
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return (
            `${label}<${el.tagName.toLowerCase()} class="${el.className}">` +
            ` h=${rect.height.toFixed(1)} w=${rect.width.toFixed(1)} left=${rect.left.toFixed(1)}` +
            ` display=${style.display} lineHeight=${style.lineHeight}` +
            (el.childNodes.length === 0 ? ' EMPTY' : '')
          );
        };
        const rows = [];
        for (const mount of this.mounts) {
          if (!mount.el.isConnected) {
            rows.push(`${mount.linktext}: not in the document`);
            continue;
          }
          const lines = [`${mount.linktext}${mount.preview ? ' (preview)' : ''}`];
          const host = mount.el.parentElement;
          if (host) {
            lines.push(describe(host, 'host  '));
            for (const child of Array.from(host.children)) {
              const mark = child === mount.el ? '  >> ' : '     ';
              lines.push(describe(child, mark));
            }
          }
          for (const child of Array.from(mount.el.children)) {
            lines.push(describe(child, '   box '));
          }
          const editor = mount.el.querySelector('.cm-editor');
          if (editor) {
            lines.push(describe(editor, '   cm  '));
            const sizer = editor.querySelector('.cm-sizer, .cm-content, .cm-scroller');
            if (sizer) lines.push(describe(sizer, '   in  '));
          }
          rows.push(lines.join('\n'));
        }
        const text = rows.length ? rows.join('\n\n') : 'No rendered section boxes in this window.';
        console.log('[live-sections] layout\n' + text);
        new obsidian.Notice('Layout report written to the console (ctrl+shift+i).', 6000);
      },
    });

  }

  onunload() {
    this.unpatchFoldCommand();
    for (const mount of this.mounts) mount.destroy();
    this.mounts.clear();
  }

  // deferred: focus handlers run inside CodeMirror's update, where dispatching throws
  refreshEditors() {
    if (this.refreshQueued) return;
    this.refreshQueued = true;
    window.setTimeout(() => {
      this.refreshQueued = false;
      this.app.workspace.iterateAllLeaves((leaf) => {
        const view = leaf.view;
        const cm = view && view.editor && view.editor.cm;
        if (!cm) return;
        try {
          cm.dispatch({ effects: refreshEffect.of(null) });
        } catch (err) {
          console.error('[live-sections] could not refresh an editor', err);
        }
      });
    }, 0);
  }

  async persist() {
    await this.saveData(Object.assign({}, this.settings, { collapsed: Array.from(this.collapsed) }));
  }

  async saveSettings() {
    this.embedLine = embedLineRegex(this.settings.embedTrigger);
    await this.persist();
    this.refreshEditors();
  }

  toggleCollapsedKey(key) {
    if (this.collapsed.has(key)) this.collapsed.delete(key);
    else this.collapsed.add(key);
    for (const mount of this.mounts) {
      if (mount.collapseKey === key) mount.applyCollapsed();
    }
    this.saveCollapsed();
    this.refreshEditors();
  }

  focusedMount() {
    const active = document.activeElement;
    if (!active) return null;
    for (const mount of this.mounts) {
      if (!mount.destroyed && mount.el.contains(active)) return mount;
    }
    return null;
  }

  foldTarget(editor, ctx) {
    const focused = this.focusedMount();
    if (focused) {
      const inner = focused.host && focused.host.obsidianEditor();
      const owner = focused.host && focused.host.owner();
      return { mount: null, editor: inner || editor, ctx: owner || ctx };
    }

    const view = this.app.workspace.getActiveViewOfType(obsidian.MarkdownView);
    if (view && view.editor) {
      const mount = this.mountForContext(view.editor, view);
      return { mount: mount && mount.collapsible ? mount : null, editor: view.editor, ctx: view };
    }
    return { mount: null, editor: null, ctx };
  }

  mountAtCursor(editor, ctx) {
    return this.foldTarget(editor, ctx).mount;
  }

  mountForContext(editor, ctx) {
    const file = ctx && ctx.file;
    if (!file || !editor || typeof editor.getCursor !== 'function') return null;
    const lineNumber = editor.getCursor().line + 1;
    for (const mount of this.mounts) {
      if (mount.destroyed || mount.sourcePath !== file.path) continue;
      const line = mount.triggerLine();
      if (line && line.number === lineNumber) return mount;
    }
    return null;
  }

  patchFoldCommand() {
    const command = this.app.commands && this.app.commands.commands['editor:toggle-fold'];
    if (!command || typeof command.editorCheckCallback !== 'function') return;
    const original = command.editorCheckCallback;
    const plugin = this;
    command.editorCheckCallback = function (checking, editor, ctx) {
      const target = plugin.foldTarget(editor, ctx);
      if (target.mount) {
        if (!checking) target.mount.toggleCollapsed();
        return true;
      }
      if (!target.editor) return false;
      return original.call(this, checking, target.editor, target.ctx);
    };
    this.foldPatch = { command, original, patched: command.editorCheckCallback };
  }

  unpatchFoldCommand() {
    if (!this.foldPatch) return;
    const { command, original, patched } = this.foldPatch;
    if (command.editorCheckCallback === patched) command.editorCheckCallback = original;
    this.foldPatch = null;
  }
}

class LiveSectionsSettingTab extends obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new obsidian.Setting(containerEl)
      .setName('Editable section embeds')
      .setDesc('Render !![[Note#H1#H2]] as the real section content, editable and synced back to the source.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.sectionEmbeds).onChange(async (value) => {
          this.plugin.settings.sectionEmbeds = value;
          await this.plugin.saveSettings();
        })
      );

    new obsidian.Setting(containerEl)
      .setName('Section embed trigger')
      .setDesc('Prefix that turns a whole line into an editable section. Avoid "!" and "!!": Obsidian claims those for its own embeds.')
      .addText((text) =>
        text.setPlaceholder('@').setValue(this.plugin.settings.embedTrigger).onChange(async (value) => {
          const trimmed = value.trim();
          if (!trimmed) return;
          this.plugin.settings.embedTrigger = trimmed;
          await this.plugin.saveSettings();
        })
      );

    new obsidian.Setting(containerEl)
      .setName('Arrow keys leave a section')
      .setDesc('On: an arrow at the first or last line of a section continues into the note around it. Off: only ctrl+arrow and escape leave, so arrows stay inside.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.exitOnPlainArrow).onChange(async (value) => {
          this.plugin.settings.exitOnPlainArrow = value;
          await this.plugin.saveSettings();
        })
      );

    new obsidian.Setting(containerEl)
      .setName('Write delay')
      .setDesc('Milliseconds of idle typing before an edited section is written to its source file.')
      .addText((text) =>
        text.setValue(String(this.plugin.settings.writeDelayMs)).onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          if (Number.isFinite(parsed) && parsed >= 50) {
            this.plugin.settings.writeDelayMs = parsed;
            await this.plugin.saveSettings();
          }
        })
      );
  }
}

module.exports = LiveSectionsPlugin;
module.exports.__test = {
  splitLinkText,
  normalizeHeading,
  parseHeadings,
  findSection,
  replaceSection,
  breadcrumbParts,
  buildOccurrenceMap,
  hasIndentedChild,
  splitTrailingBlank,
  embedLineRegex,
  triggerPlacement,
  stepTargetLine,
  skipTargetLine,
};
