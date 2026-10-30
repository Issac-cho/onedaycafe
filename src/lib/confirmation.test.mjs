import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const code = ts.transpileModule(readFileSync(new URL("../components/useConfirmation.tsx", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const message = { title: "최종 완료", description: "확인", details: ["커피 2/3 → 3/3"], confirmLabel: "커피 3개 조리 완료" };

function setup() {
  const states = [];
  let cursor = 0, cleanup;
  const exports = {};
  const dependencies = {
    react: {
      useState(initial) {
        const index = cursor++;
        if (!(index in states)) states[index] = initial;
        return [states[index], next => { states[index] = next; }];
      },
      useRef(initial) { const index = cursor++; return states[index] ??= { current: initial }; },
      useCallback: callback => callback,
      useEffect: effect => { cleanup = effect(); },
    },
    "@/components/ui/button": { Button: "button" },
    "@/components/ui/dialog": Object.fromEntries(["Dialog", "DialogContent", "DialogHeader", "DialogTitle", "DialogDescription", "DialogFooter"].map(name => [name, name])),
  };
  vm.runInNewContext(code, { exports, require: name => dependencies[name] ?? require(name) });
  const render = () => { cursor = 0; return exports.useConfirmation(); };
  return { render, cleanup: () => cleanup() };
}

function findButton(node, label) {
  if (Array.isArray(node)) return node.map(child => findButton(child, label)).find(Boolean);
  if (!node?.props) return;
  if (node.type === "button" && node.props.children === label) return node.props;
  return findButton(node.props.children, label);
}

test("confirmation resolves true only after explicitly confirming", async () => {
  const app = setup();
  const pending = app.render().confirm(message);
  const dialog = app.render().confirmationDialog;
  assert.equal(dialog.props.open, true);
  assert.equal(findButton(dialog, "돌아가기").autoFocus, true);
  findButton(dialog, message.confirmLabel).onClick();
  assert.equal(await pending, true);
  assert.equal(app.render().confirmationDialog.props.open, false);
});

test("back, close, unmount and repeated opening do not confirm an action", async () => {
  for (const dismiss of ["back", "close", "unmount"]) {
    const app = setup();
    const pending = app.render().confirm(message);
    assert.equal(await app.render().confirm(message), false);
    const dialog = app.render().confirmationDialog;
    if (dismiss === "back") findButton(dialog, "돌아가기").onClick();
    else if (dismiss === "close") dialog.props.onOpenChange(false);
    else app.cleanup();
    assert.equal(await pending, false);
  }
});
