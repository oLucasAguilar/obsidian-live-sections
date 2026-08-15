/* Checks the parsing behind the plugin. Obsidian's API is stubbed, so this
 * runs with plain node and needs no vault. */

const path = require('path');
const Module = require('module');

class Fake {
  constructor() {}
  static fromClass() { return {}; }
  static of() { return {}; }
  static define() { return { of: () => ({}) }; }
  static replace() { return { range: () => ({}) }; }
  static widget() { return { range: () => ({}) }; }
  static set() { return {}; }
}
const fakeObsidian = {
  Plugin: Fake, PluginSettingTab: Fake, Setting: Fake, Notice: Fake,
  debounce: (fn) => fn, editorInfoField: null, Keymap: { isModEvent: () => false },
};
const fakeView = { Decoration: Fake, EditorView: Fake, ViewPlugin: Fake, WidgetType: Fake, keymap: Fake };
const fakeState = { Prec: Fake, StateEffect: Fake, StateField: Fake };

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'obsidian') return fakeObsidian;
  if (request === '@codemirror/view') return fakeView;
  if (request === '@codemirror/state') return fakeState;
  return origLoad.apply(this, arguments);
};

const { __test: t } = require(path.join(__dirname, '..', 'main.js'));

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}`);
}

/* ---- reading a link ---- */
check('nested anchor', t.splitLinkText('Note#One#Two'),
  { path: 'Note', segments: ['One', 'Two'], alias: null, isBlockRef: false, subpath: 'One#Two' });
check('alias is kept apart', t.splitLinkText('Note#One|shown').alias, 'shown');
check('no anchor means no segments', t.splitLinkText('Note').segments, []);
check('a link into the same note has no path', t.splitLinkText('#One#Two').path, '');
check('a block ref is recognised', t.splitLinkText('Note#^abc123').isBlockRef, true);
check('same note link shows only the headings', t.breadcrumbParts('', ['One', 'Two']), ['One', 'Two']);
check('another note is named first', t.breadcrumbParts('dir/Note', ['One']), ['Note', 'One']);

/* ---- the trigger line ---- */
const AT = t.embedLineRegex('@');
check('plain trigger', AT.test('@[[Note#One]]'), true);
check('inside a bullet', AT.test('  - @[[Note#One]]'), true);
check('captures the link', '@[[Note#One]]'.match(AT)[2], 'Note#One');
check('a plain link is not a trigger', AT.test('[[Note#One]]'), false);
check('an obsidian embed is not a trigger', AT.test('![[Note#One]]'), false);
check('trailing text is not a trigger yet', AT.test('@[[Note#One]] and more'), false);
check('mid line use is not a trigger', AT.test('write to me @[[Note#One]]'), false);
check('regex characters in the trigger are escaped', t.embedLineRegex('++').test('++[[A#B]]'), true);

/* ---- block or inline, the rule Obsidian uses for its own embeds ---- */
check('alone at the start of the line is a block',
  t.triggerPlacement('@[[A#B]]', AT), { prefix: '', linktext: 'A#B', block: true });
check('a bullet in front forces inline',
  t.triggerPlacement('- @[[A#B]]', AT), { prefix: '- ', linktext: 'A#B', block: false });
check('so does a nested bullet',
  t.triggerPlacement('    - @[[A#B]]', AT), { prefix: '    - ', linktext: 'A#B', block: false });
check('so does plain indentation', t.triggerPlacement('  @[[A#B]]', AT).block, false);
check('and a numbered item', t.triggerPlacement('1. @[[A#B]]', AT).block, false);
check('a line without a trigger has no placement', t.triggerPlacement('- [[A#B]]', AT), null);

/* ---- finding the section a link points at ---- */
const note = [
  '# Top',
  '## Ideas',
  '#### Ana',
  'nested body line',
  '#### Bea',
  'other',
  '## Ana',
  'unrelated top level section',
  '## After',
].join('\n');

const nested = t.findSection(note, ['Ideas', 'Ana']);
check('a nested anchor finds the nested heading', nested.headingLine, 2);
check('the body stops at the next sibling', nested.body, 'nested body line');
check('the level is the nested one', nested.level, 4);
check('a flat anchor is ambiguous and takes the first', t.findSection(note, ['Ana']).headingLine, 2);
check('a parent section spans its children', t.findSection(note, ['Ideas']).bodyEnd, 6);
check('a missing heading resolves to nothing', t.findSection(note, ['Ideas', 'Nope']), null);
check('wrong nesting resolves to nothing', t.findSection(note, ['Bea', 'Ana']), null);

const fenced = ['## Real', '```', '## Not a heading, it is code', '```', 'tail', '## Next'].join('\n');
check('headings inside code fences are ignored', t.parseHeadings(fenced).headings.map((h) => h.text), ['Real', 'Next']);
check('a section keeps the fenced content', t.findSection(fenced, ['Real']).bodyEnd, 5);

check('case and spacing do not matter', t.normalizeHeading('  Some   HEADING  '), 'some heading');
check('emphasis does not matter', t.normalizeHeading('**Bold** heading'), 'bold heading');
const decomposed = 'Ma\u0303e';
const composed = 'M\u00e3e';
check('the fixtures really differ in bytes', decomposed !== composed, true);
check('composed and decomposed text match', t.normalizeHeading(decomposed), t.normalizeHeading(composed));
check('a decomposed anchor still finds its heading',
  t.findSection(['## Ideas', '#### ' + composed, 'body'].join('\n'), ['Ideas', decomposed]).headingLine, 1);

/* ---- writing back ---- */
const edited = t.replaceSection(note, ['Ideas', 'Ana'], 'first\nsecond');
check('only the target section changes', edited.split('\n').slice(0, 6),
  ['# Top', '## Ideas', '#### Ana', 'first', 'second', '#### Bea']);
check('the unrelated heading of the same name is untouched', edited.includes('unrelated top level section'), true);
check('an unknown heading writes nothing', t.replaceSection(note, ['Nope'], 'x'), null);
check('a section can be emptied', t.replaceSection(note, ['Ideas', 'Ana'], '').split('\n')[3], '');

/* ---- the blank line before the next heading is held back, never lost ---- */
check('one blank line comes off', t.splitTrailingBlank('- item\n'), { text: '- item', trailing: '\n' });
check('several come off', t.splitTrailingBlank('- item\n\n\n'), { text: '- item', trailing: '\n\n\n' });
check('indented blanks count as blank', t.splitTrailingBlank('- item\n   \n'), { text: '- item', trailing: '\n   \n' });
check('a body without one is untouched', t.splitTrailingBlank('- item'), { text: '- item', trailing: '' });
for (const body of ['- a\n- b\n', '- a', '', '\n', 'x\n \n\t\n']) {
  const split = t.splitTrailingBlank(body);
  check(`text plus trailing rebuilds ${JSON.stringify(body)}`, split.text + split.trailing, body);
}

/* ---- arrow keys around a rendered section ---- */
const layout = ['- [[Other]] note', '@[[Note#One]]', '', '- '];
check('arrowing up from below lands on the section', t.stepTargetLine(layout, 3, -1, AT), 2);
check('arrowing up from the section itself is left alone', t.stepTargetLine(layout, 2, -1, AT), null);
check('arrowing down from above lands on the section', t.stepTargetLine(layout, 1, 1, AT), 2);
check('nothing above the first line', t.stepTargetLine(layout, 1, -1, AT), null);
check('nothing below the last line', t.stepTargetLine(layout, 4, 1, AT), null);

const stacked = ['before', '@[[A#B]]', '@[[C#D]]', 'after'];
check('ctrl+arrow clears a stack of sections in one jump', t.skipTargetLine(stacked, 1, 1, AT), 4);
check('and the same going up', t.skipTargetLine(stacked, 4, -1, AT), 1);
check('ctrl+arrow stays out of it when the neighbour is ordinary', t.skipTargetLine(layout, 4, -1, AT), null);
check('with nothing beyond the run it settles on the edge',
  t.skipTargetLine(['@[[A#B]]', 'after'], 2, -1, AT), 1);

/* ---- a trigger line with children belongs to the native fold ---- */
const withChild = ['- @[[A#B]]', '\t- written by hand', '- next'];
check('an indented line under it counts as a child', t.hasIndentedChild(withChild, 1), true);
check('a sibling below is not a child', t.hasIndentedChild(withChild, 3), false);
const spaced = ['- @[[A#B]]', '', '    - after a blank line', 'end'];
check('a blank line does not end the item', t.hasIndentedChild(spaced, 1), true);
const alone = ['- @[[A#B]]', '- sibling'];
check('a plain sibling is not a child', t.hasIndentedChild(alone, 1), false);
check('nothing below means no child', t.hasIndentedChild(alone, 2), false);
const tabbed = ['\t- @[[A#B]]', '\t\t- deeper'];
check('tabs are measured the same as spaces', t.hasIndentedChild(tabbed, 1), true);
const outdented = ['\t- @[[A#B]]', '- back out'];
check('a line further out is not a child', t.hasIndentedChild(outdented, 1), false);

/* Every path that builds a box has to agree on whether it can collapse, or the
 * same box renders one way rendered and another way in preview. */
const source = require('fs').readFileSync(require('path').join(__dirname, '..', 'main.js'), 'utf8');
const builders = (source.match(/new SectionWidget\(/g) || []).length;
const withFlag = (source.match(/new SectionWidget\([\s\S]{0,220}?collapsible/g) || []).length;
check('every box is told whether it can collapse', withFlag, builders);
check('both builders work it out the same way',
  (source.match(/(?<!function )hasIndentedChild\(lineTexts, /g) || []).length, 2);

/* ---- two of the same link are two separate boxes ---- */
const repeated = ['- @[[A#B]]', 'text', '- @[[A#B]]', '- @[[C#D]]', '- @[[A#B]]'];
const occurrences = t.buildOccurrenceMap(repeated, AT);
check('the first use is zero', occurrences.get(1), 0);
check('the second is one', occurrences.get(3), 1);
check('the third is two', occurrences.get(5), 2);
check('another link counts on its own', occurrences.get(4), 0);
check('lines without a trigger are absent', occurrences.has(2), false);
const moved = ['heading', ''].concat(repeated);
check('writing above them does not renumber', t.buildOccurrenceMap(moved, AT).get(3), 0);
check('nor the later ones', t.buildOccurrenceMap(moved, AT).get(7), 2);

/* ---- a section that leads back to itself ---- */
check('the key names note and heading', t.sectionKey('Recipes.md', ['Bread', 'Sourdough']),
  'Recipes.md#bread#sourdough');
check('the key reads headings the way links do', t.sectionKey('Recipes.md', ['  BREAD ']),
  t.sectionKey('Recipes.md', ['Bread']));
check('a whole note has a key too', t.sectionKey('Recipes.md', []), 'Recipes.md#');
check('the same note under another name is another key',
  t.sectionKey('Notes/Recipes.md', ['Bread']) === t.sectionKey('Recipes.md', ['Bread']), false);

const bread = t.sectionKey('Recipes.md', ['Bread']);
const sourdough = t.sectionKey('Recipes.md', ['Bread', 'Sourdough']);
check('a section inside itself stops', t.embedGuard([bread], bread, 1, 3), 'cycle');
check('so does a longer ring', t.embedGuard([bread, sourdough], bread, 2, 3), 'cycle');
check('a cycle stops however much room is left', t.embedGuard([bread], bread, 1, 99), 'cycle');
check('different sections nest freely', t.embedGuard([bread], sourdough, 1, 3), null);
check('the first box is never blocked', t.embedGuard([], bread, 0, 3), null);
check('stacking stops at the limit', t.embedGuard([], bread, 3, 3), 'depth');
check('and below it goes on', t.embedGuard([], bread, 2, 3), null);
check('a limit of one allows the outermost box only', t.embedGuard([], bread, 1, 1), 'depth');

/* The cut has to happen before the editor is built, or the loop has already
 * started by the time it is noticed. */
const guardCall = source.indexOf('= embedGuard(');
check('the guard is called at all', guardCall > 0, true);
check('the guard runs before the nested editor exists',
  guardCall < source.indexOf('new SectionEditorHost('), true);
check('the box that is building is told to the boxes it builds',
  /buildStack\.push\([\s\S]{0,400}?new SectionEditorHost\([\s\S]{0,400}?buildStack\.pop\(\)/.test(source), true);

console.log(`\n${failures === 0 ? 'all checks passed' : failures + ' FAILURES'}`);
process.exit(failures === 0 ? 0 : 1);
