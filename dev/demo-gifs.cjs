const { open, sleep } = require('./obsidian-demo.cjs');
const P = require('path').resolve(__dirname, '..'), T = process.env.THEME, O = process.env.OUTDIR || require('path').resolve(__dirname, '../docs');
const base = { id: 'live-sections', pluginDir: P, files: ['main.js', 'manifest.json', 'styles.css'], theme: T };
const PLAIN = '## Bread\n\nFlour, water, salt.\nBake at 230 °C.\n\n## Soup\n\nLeeks and potatoes.\n';
const LIST = '## Bread\n\n- Flour\n\t- 500 g, whole wheat\n- Water\n\t- 350 ml, warm\n- Salt\n\n## Soup\n\nLeeks and potatoes.\n';
// the section shows up under the trigger, you type in it, the source note on the right changes
async function editing({ recipes, trigger, line, typed, out }) {
  const d = await open({ ...base, width: 980, height: 420, notes: { 'Recipes.md': recipes, 'Today.md': 'Shopping list:\n\n' }, openNote: 'Today' });
  await d.split('Recipes.md'); await d.focusLeaf(0); await d.focusEnd(); await d.hold(900);
  await d.type(trigger, 50); await d.type('\n', 200); await sleep(1000); await d.hold(1400);
  const b = await d.textEnd('.cm-editor .cm-editor .cm-line', line);
  await d.pointer(b.x, b.y, { steps: 14 }); await d.click(500);
  await d.keys(typed, 75); await sleep(1300); await d.hold(3000);
  console.log(await d.gif(`${O}/${out}-${T}.gif`)); await d.close();
}
(async () => {
  await editing({ recipes: PLAIN, trigger: '@[[Recipes#Bread]]', line: 'Bake at', typed: ' for 40 min', out: 'editing' });
  // collapsing: the arrow left of the bullet folds the section, like any list item
  const d = await open({ ...base, width: 640, height: 400, notes: { 'Recipes.md': LIST, 'Today.md': 'Shopping list:\n\n- @[[Recipes#Bread]]\n- Eggs\n' }, openNote: 'Today' });
  await d.cursor(4, 0); await d.js(() => document.activeElement.blur()); await sleep(900); await d.hold(1500);
  const arrow = async () => d.js(() => { const r = document.querySelector('.cm-fold-indicator.live-sections-fold').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  let a = await arrow(); await d.pointer(a.x + 30, a.y, { steps: 14, ms: 50 }); await d.hold(600);
  await d.pointer(a.x, a.y, { steps: 6, ms: 60 }); await d.hold(700); await d.click(2200);
  a = await arrow(); await d.pointer(a.x, a.y, { steps: 2, ms: 60 }); await d.hold(500); await d.click(2200);
  console.log(await d.gif(`${O}/collapsing-${T}.gif`)); await d.close();
})().catch(e => { console.error(e); process.exit(1); });
