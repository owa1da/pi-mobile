// Structural wiring checks complement ChatView's mounted tests without booting stores/SSH.
import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { workingRowVisible } from "./chrome";

const source = ts.createSourceFile(
  "session-screen.tsx",
  readFileSync(new URL("./session-screen.tsx", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
function findAll(predicate: (node: ts.Node) => boolean): ts.Node[] {
  const found: ts.Node[] = [];
  const visit = (node: ts.Node) => {
    if (predicate(node)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}
function variable(name: string): ts.VariableDeclaration {
  const nodes = findAll(
    (node) => ts.isVariableDeclaration(node) && node.name.getText(source) === name,
  );
  expect(nodes).toHaveLength(1);
  return nodes[0] as ts.VariableDeclaration;
}
function tag(name: string): ts.JsxSelfClosingElement {
  const nodes = findAll(
    (node) => ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === name,
  );
  expect(nodes).toHaveLength(1);
  return nodes[0] as ts.JsxSelfClosingElement;
}

describe("session activity UI wiring", () => {
  it("sends the sole WorkingRow to ChatView, never to a composer sibling", () => {
    const activity = variable("activity").initializer!;
    expect(ts.isCallExpression(activity)).toBe(true);
    const memo = activity as ts.CallExpression;
    expect(memo.expression.getText(source)).toBe("useMemo");
    expect(memo.arguments[1].getText(source)).toBe("[working, hostId, row.since]");
    const render = memo.arguments[0] as ts.ArrowFunction;
    expect(ts.isArrowFunction(render)).toBe(true);
    const body = render.body as ts.ParenthesizedExpression;
    expect(ts.isParenthesizedExpression(body)).toBe(true);
    const conditional = body.expression as ts.ConditionalExpression;
    expect(ts.isConditionalExpression(conditional)).toBe(true);
    expect(conditional.condition.getText(source)).toBe("working");
    expect(conditional.whenFalse.kind).toBe(ts.SyntaxKind.NullKeyword);
    expect(conditional.whenTrue).toBe(tag("WorkingRow"));
    const chat = tag("ChatView");
    const prop = chat.attributes.properties.find(
      (node) => ts.isJsxAttribute(node) && node.name.getText(source) === "activity",
    ) as ts.JsxAttribute;
    expect(prop?.initializer?.getText(source)).toBe("{activity}");
    // The branch is available before a session file appears, without adding fixed chrome.
    expect(chat.parent.parent.getText(source)).toContain("feed.hasFile || working");
  });

  it("uses the existing visibility contract: idle/waiting/closed/held/disconnected are not working", () => {
    expect(variable("working").initializer!.getText(source)).toBe(
      "workingRowVisible(row.state, connection.status, held)",
    );
    expect(workingRowVisible("working", "connected", false)).toBe(true);
    for (const state of ["idle", "waiting", "closed"] as const)
      expect(workingRowVisible(state, "connected", false)).toBe(false);
    expect(workingRowVisible("working", "connected", true)).toBe(false);
    for (const status of ["idle", "connecting", "reconnecting", "failed"] as const)
      expect(workingRowVisible("working", status, false)).toBe(false);
  });

  it("allows working text and elapsed clock to wrap at large text sizes", () => {
    const workingFunction = findAll(
      (node) => ts.isFunctionDeclaration(node) && node.name?.text === "WorkingRow",
    )[0];
    expect(workingFunction.getText(source)).not.toContain("numberOfLines");
    expect(workingFunction.getText(source)).toContain("workingClock(since, hostNow(");
    expect(workingFunction.getText(source)).toContain('testID="chat-working"');
  });
});
