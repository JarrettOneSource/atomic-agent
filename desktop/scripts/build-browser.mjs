import ts from 'typescript';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = ts.createSourceFile('preload.ts', readFileSync(join(root, 'preload/preload.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
const factory = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'createAtomicApi');
if (!factory) throw new Error('The shared GUI API factory is missing');
const channels = { invoke: new Set(), send: new Set(), sendSync: new Set(), events: new Set() };
function visit(node) {
  if (ts.isCallExpression(node) && ts.isStringLiteral(node.arguments[0])) {
    const expression = node.expression;
    if (ts.isPropertyAccessExpression(expression) && expression.expression.getText(source) === 'ipcRenderer') {
      channels[expression.name.text]?.add(node.arguments[0].text);
    } else if (ts.isIdentifier(expression) && expression.text === 'on') {
      channels.events.add(node.arguments[0].text);
    }
  }
  ts.forEachChild(node, visit);
}
visit(factory);
const out = join(root, 'out/renderer');
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'atomic-api.js'), ts.transpileModule(factory.getText(source), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText);
writeFileSync(join(out, 'browser-channels.json'), JSON.stringify(Object.fromEntries(
  Object.entries(channels).map(([kind, values]) => [kind, [...values].sort()]),
)));
copyFileSync(join(root, 'browser/browser-bridge.js'), join(out, 'browser-bridge.js'));
copyFileSync(join(root, 'browser/browser.css'), join(out, 'browser.css'));
console.log('Built the browser transport from the shared GUI API.');

copyFileSync(join(root, 'build/icon.ico'), join(out, 'favicon.ico'));
