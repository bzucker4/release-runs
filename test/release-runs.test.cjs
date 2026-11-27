const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createRequire } = require("node:module");
const { readFileSync } = require("node:fs");
const vm = require("node:vm");

class TFile {
  constructor(path, text) {
    this.path = path;
    this.basename = path.split("/").at(-1).slice(0, -3);
    this.extension = "md";
    this.text = text;
  }
}
class TFolder {}
class Element {
  constructor(tag = "div", options = {}) {
    this.tag = tag;
    this.children = [];
    this.handlers = {};
    this.textContent = options.text ?? "";
    this.value = options.value ?? "";
  }
  createEl(tag, options) { const child = new Element(tag, options); this.children.push(child); return child; }
  createSpan(options) { return this.createEl("span", options); }
  createDiv(options) { return this.createEl("div", options); }
  setAttribute() {}
  addClass() {}
  focus() {}
  select() {}
  addEventListener(event, callback) { this.handlers[event] = callback; }
  async emit(event) { await this.handlers[event]({ preventDefault() {} }); }
  find(match) {
    if (match(this)) return this;
    for (const child of this.children) {
      const found = child.find(match);
      if (found) return found;
    }
  }
}
class Modal {
  constructor(app) { this.app = app; this.contentEl = new Element(); }
  setTitle(title) { this.title = title; }
  open() { this.app.dialog = this; this.onOpen(); }
  close() { this.app.dialog = null; }
}
class FuzzySuggestModal extends Modal {
  setPlaceholder() {}
  open() { this.app.picker = this; }
}
class Plugin {
  constructor(app) { this.app = app; this.commands = {}; }
  addCommand(command) { this.commands[command.id] = command; }
  registerEvent() {}
}
const obsidian = {
  FuzzySuggestModal, Modal, Plugin, TFile, TFolder,
  Notice: class { constructor(message) { notices.push(message); } },
  parseYaml: text => Object.fromEntries(text.split("\n").filter(line => line.includes(": ")).map(line => {
    const split = line.indexOf(": ");
    const key = line.slice(0, split);
    const value = line.slice(split + 2);
    return [key, value.startsWith('"') ? JSON.parse(value) : value];
  }))
};
const notices = [];
const localRequire = createRequire(__filename);
const sandbox = {
  module: { exports: {} },
  require: id => id === "obsidian" ? obsidian : localRequire(id)
};
vm.runInNewContext(readFileSync(require("node:path").join(__dirname, "../main.js"), "utf8") +
  "\nmodule.exports.test = { checklistItems, parseRun, runDocument, updateResults, compareRuns };", sandbox);
const ReleaseRuns = sandbox.module.exports;
const model = ReleaseRuns.test;
const plain = value => JSON.parse(JSON.stringify(value));

function fixture() {
  const files = new Map();
  const source = new TFile("Checks/Smoke tests.md", "- [x] Login ^login\n- [ ] Export");
  files.set(source.path, source);
  let active = source;
  const app = {
    workspace: {
      on() {},
      getActiveFile: () => active,
      getLeaf: () => ({ openFile: async file => { active = file; } })
    },
    metadataCache: {
      getFileCache: () => undefined,
      getFirstLinkpathDest: link => files.get(link + ".md")
    },
    fileManager: { generateMarkdownLink: file => `[[${file.path}]]` },
    vault: {
      getAbstractFileByPath: path => files.get(path),
      createFolder: async path => { files.set(path, new TFolder()); },
      create: async (path, text) => {
        const file = new TFile(path, text);
        files.set(path, file);
        return file;
      },
      read: async file => file.text,
      cachedRead: async file => file.text,
      process: async (file, edit) => { file.text = edit(file.text); return file.text; },
      getFiles: () => [...files.values()].filter(file => file instanceof TFile),
      getMarkdownFiles: () => [...files.values()].filter(file => file instanceof TFile)
    }
  };
  const plugin = new ReleaseRuns(app);
  plugin.onload();
  return { app, plugin, source, files };
}

async function tick() { await new Promise(resolve => setImmediate(resolve)); }

test("extracts active, nested and quoted checklist items and ignores examples and duplicates safely", () => {
  const items = model.checklistItems([
    "---", "sample: |", "  - [ ] property", "---", "## Test",
    "- [x] Build ^build", "  - [ ] Shared", "1. [/] Shared",
    "> ~~~md", "> - [ ] Example", "> ~~~", "> - [ ] Quoted",
    "```md", "- [ ] Example", "```", "<!--", "- [ ] hidden", "-->", "- [ ] "
  ].join("\r\n"));
  assert.deepEqual(plain(items.map(({ label, status }) => [label, status])), [
    ["Build", "Untested"], ["Shared", "Untested"], ["Shared", "Untested"], ["Quoted", "Untested"]
  ]);
  assert.equal(new Set(items.map(item => item.key)).size, 4);
});

test("updates one result without rewriting unrelated text or losing simultaneous changes", () => {
  const run = {
    source: "Some/Checklist.md", created: "2026-11-27T12:00:00.000Z",
    name: 'Test: "1"', version: "", environment: "", items: model.checklistItems("- [ ] One\n- [ ] Two")
  };
  let note = model.runDocument(run).replaceAll("\n", "\r\n") + "\r\n## My notes\r\nKeep me.\r\n";
  const [first, second] = model.parseRun(note).items;
  note = model.updateResults(note, [{ before: first, next: { status: "Failed", evidence: "[[Screenshot.png]]" } }]);
  note = model.updateResults(note, [{ before: second, next: { status: "Passed", evidence: "https://example.com/log" } }]);
  assert.match(note, /\*\*Status:\*\* Failed\r\n\r\n\*\*Evidence:\*\* \[\[Screenshot\.png\]\]/);
  assert.match(note, /## My notes\r\nKeep me\.\r\n$/);
  assert.throws(() => model.updateResults(note, [{ before: first, next: { status: "Passed", evidence: "" } }]), /changed while/);
  assert.equal(model.parseRun(note).items[1].status, "Passed");
});

test("tracks a renamed check by block ID and shows changed, added and removed results", () => {
  const previous = { items: model.checklistItems("- [ ] Build ^same\n- [ ] Old") };
  previous.items[0].status = "Passed";
  const current = { items: model.checklistItems("- [ ] Build the installer ^same\n- [ ] New") };
  Object.assign(current.items[0], { status: "Failed", evidence: "Broken" });
  assert.deepEqual(plain(model.compareRuns(previous, current).map(change => change.kind)), [
    "Passed → Failed · Renamed · Evidence changed", "Added", "Removed"
  ]);
});

test("runs the command, save, reload and previous-run comparison workflow", async () => {
  const { app, plugin, source, files } = fixture();
  const start = () => plugin.commands["start-run"].editorCallback({ getValue: () => source.text }, { file: source });
  start();
  await tick();
  assert.equal(app.dialog.title, "Start new run");
  const startForm = app.dialog.contentEl.find(el => el.tag === "form");
  await startForm.emit("submit");
  assert.equal(app.dialog.title, "Record results");

  const first = app.workspace.getActiveFile();
  const old = model.parseRun(first.text).created;
  first.text = first.text.replace(old, new Date(Date.parse(old) - 1000).toISOString());
  const firstResult = app.dialog.contentEl.find(el => el.tag === "form");
  firstResult.find(el => el.tag === "select").value = "Passed";
  firstResult.find(el => el.tag === "input").value = "[[Screenshots/Login.png]]";
  await firstResult.emit("submit");
  assert.match(first.text, /\*\*Evidence:\*\* \[\[Screenshots\/Login.png\]\]/);
  assert.match(first.text, /\*\*Status:\*\* Passed/);

  files.delete(source.path);
  source.path = "Checks/Renamed tests.md";
  files.set(source.path, source);
  first.text = first.text.replace("Source checklist: [[Checks/Smoke tests]]", "Source checklist: [[Checks/Renamed tests]]");
  source.text = "- [ ] Sign in ^login\n- [ ] Search";
  start();
  await tick();
  await app.dialog.contentEl.find(el => el.tag === "form").emit("submit");

  const secondResult = app.dialog.contentEl.find(el => el.tag === "form");
  secondResult.find(el => el.tag === "select").value = "Failed";
  secondResult.find(el => el.tag === "input").value = "Reproduced on a new account.";
  await secondResult.emit("submit");
  const compare = plugin.commands["compare-previous-run"];
  assert.equal(compare.checkCallback(true), true);
  compare.checkCallback(false);
  await tick();
  assert.equal(app.dialog.title, "Compare with previous run");
  assert.ok(app.dialog.contentEl.find(el => el.textContent === "Passed → Failed · Renamed · Evidence changed"));
  assert.ok(app.dialog.contentEl.find(el => el.textContent === "Added · Untested"));
  assert.ok(app.dialog.contentEl.find(el => el.textContent === "Removed · Untested"));
  await app.dialog.contentEl.find(el => el.textContent === "Open previous run").emit("click");
  assert.equal(app.workspace.getActiveFile(), first);
  assert.deepEqual(notices, []);
});

test("compares to the previous run in the same environment when requested", async () => {
  const { app, plugin, source, files } = fixture();
  const runs = [
    ["2026-11-25T10:00:00.000Z", "Prod", "First production"],
    ["2026-11-26T10:00:00.000Z", "Staging", "Staging"],
    ["2026-11-27T10:00:00.000Z", " prod ", "Current"],
    ["2026-11-28T10:00:00.000Z", "prod", "Future production"]
  ].map(([created, environment, name]) => {
    const path = "Release Runs/" + name + ".md";
    const file = new TFile(path, model.runDocument({
      name, created, environment, version: "", source: source.path, items: model.checklistItems(source.text)
    }));
    files.set(path, file);
    return file;
  });
  const current = await plugin.readRun(runs[2]);
  assert.equal((await plugin.previousRun(runs[2], current)).file, runs[1]);

  await app.workspace.getLeaf(false).openFile(runs[2]);
  const compare = plugin.commands["compare-same-environment"];
  assert.equal(compare.checkCallback(true), true);
  compare.checkCallback(false);
  await tick();

  assert.equal(app.dialog.title, "Compare runs in the same environment");
  assert.equal(app.dialog.file, runs[0]);
});

test("adds a vault attachment to evidence and saves two drafts in a single write", async () => {
  const { app, plugin, source, files } = fixture();
  const screenshot = new TFile("Screenshots/Login result.png", "");
  screenshot.extension = "png";
  files.set(screenshot.path, screenshot);
  plugin.commands["start-run"].editorCallback({ getValue: () => source.text }, { file: source });
  await tick();
  await app.dialog.contentEl.find(el => el.tag === "form").emit("submit");
  const file = app.workspace.getActiveFile();
  const modal = app.dialog.contentEl;
  const list = modal.find(el => el.children.filter(child => child.tag === "form").length === 2);
  const [first, second] = list.children;
  first.find(el => el.tag === "select").value = "Passed";
  first.find(el => el.tag === "input").value = "Verified sign-in.";
  await first.find(el => el.textContent === "Link vault file").emit("click");
  assert.ok(app.picker.getItems().includes(screenshot));
  assert.ok(!app.picker.getItems().includes(file));
  assert.equal(app.picker.getItemText(screenshot), screenshot.path);
  app.picker.onChooseItem(screenshot);
  second.find(el => el.tag === "select").value = "Blocked";
  await second.emit("input");
  assert.ok(modal.find(el => el.textContent === "2 unsaved"));
  let writes = 0;
  const process = app.vault.process;
  app.vault.process = async (...args) => { writes++; return process(...args); };
  await modal.find(el => el.textContent === "Save all results").emit("click");
  assert.equal(writes, 1);
  const run = await plugin.readRun(file);
  assert.equal(run.items[0].status, "Passed");
  assert.equal(run.items[0].evidence, "Verified sign-in. [[Screenshots/Login result.png]]");
  assert.equal(run.items[1].status, "Blocked");
  assert.ok(modal.find(el => el.textContent === "All results saved"));
});

test("a conflicting batch leaves the file and both drafts intact", async () => {
  const { app, plugin, source } = fixture();
  plugin.commands["start-run"].editorCallback({ getValue: () => source.text }, { file: source });
  await tick();
  await app.dialog.contentEl.find(el => el.tag === "form").emit("submit");
  const file = app.workspace.getActiveFile();
  const modal = app.dialog.contentEl;
  const list = modal.find(el => el.children.filter(child => child.tag === "form").length === 2);
  const [first, second] = list.children;
  const before = (await plugin.readRun(file)).items[1];
  const external = model.updateResults(file.text, [{ before, next: { status: "Passed", evidence: "External edit" } }]);
  file.text = external;
  first.find(el => el.tag === "select").value = "Passed";
  second.find(el => el.tag === "select").value = "Failed";
  await second.emit("input");
  await modal.find(el => el.textContent === "Save all results").emit("click");
  assert.equal(file.text, external);
  assert.equal(second.find(el => el.tag === "select").value, "Failed");
  assert.ok(modal.find(el => /Export.*changed while/.test(el.textContent)));
  assert.ok(modal.find(el => el.textContent === "2 unsaved"));
});
