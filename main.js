const { FuzzySuggestModal, Modal, Notice, Plugin, TFile, TFolder, parseYaml } = require("obsidian");

const RUNS_FOLDER = "Release Runs";
const SCHEMA = "release-runs/v1";
const STATUSES = ["Untested", "Passed", "Failed", "Blocked"];
const ITEM_MARKER = /^<!-- release-runs:item (\S+) -->$/;
const CHECKBOX = /^\s*(?:[-*+]|\d{1,9}[.)])\s+\[[^\]\r\n]\]\s+(.+?)\s*$/;
const BLOCK_ID = /\s+\^([a-zA-Z0-9-]+)\s*$/;

function checklistItems(markdown) {
  const lines = markdown.replace(/^\uFEFF/, "").split(/\r?\n/);
  const occurrences = new Map();
  const items = [];
  let start = 0;
  let fence;
  let commentEnd;

  if (lines[0] === "---") {
    const end = lines.findIndex((line, index) => index > 0 && /^(---|\.\.\.)\s*$/.test(line));
    if (end !== -1) start = end + 1;
  }

  for (const original of lines.slice(start)) {
    const quoted = /^\s*>/.test(original);
    const line = original.replace(/^(?:\s*>[ \t]?)+/, "");
    if (fence && fence.quoted !== quoted) fence = undefined;
    const delimiter = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (delimiter && delimiter[1][0] === fence.marker &&
          delimiter[1].length >= fence.length && !delimiter[2].trim()) fence = undefined;
      continue;
    }
    if (commentEnd) {
      if (line.includes(commentEnd)) commentEnd = undefined;
      continue;
    }
    const comment = /^\s*(<!--|%%)(.*)$/.exec(line);
    if (comment) {
      const closing = comment[1] === "%%" ? "%%" : "-->";
      if (!comment[2].includes(closing)) commentEnd = closing;
      continue;
    }
    if (delimiter) {
      fence = { marker: delimiter[1][0], length: delimiter[1].length, quoted };
      continue;
    }

    const matched = CHECKBOX.exec(line);
    if (!matched) continue;
    const block = BLOCK_ID.exec(matched[1]);
    const label = matched[1].replace(BLOCK_ID, "").trim();
    if (!label) continue;
    const identity = block ? ["block", block[1]] : ["label", label];
    const identityString = JSON.stringify(identity);
    const occurrence = (occurrences.get(identityString) ?? 0) + 1;
    occurrences.set(identityString, occurrence);
    items.push({
      key: JSON.stringify([...identity, occurrence]),
      label,
      status: "Untested",
      evidence: ""
    });
  }
  return items;
}

function runDocument(run) {
  const field = value => JSON.stringify(value);
  const sourceLink = /[|#[\]]/.test(run.source)
    ? ""
    : `Source checklist: [[${run.source.slice(0, -3)}]]`;
  const lines = [
    "---",
    `release-runs-schema: ${field(SCHEMA)}`,
    `release-runs-source: ${field(run.source)}`,
    `release-runs-created: ${field(run.created)}`,
    `release-runs-name: ${field(run.name)}`,
    `release-runs-version: ${field(run.version)}`,
    `release-runs-environment: ${field(run.environment)}`,
    "---",
    "",
    `# ${run.name}`,
    ""
  ];
  if (sourceLink) lines.push(sourceLink, "");
  if (run.version) lines.push(`**Version or deployment:** ${run.version}`, "");
  if (run.environment) lines.push(`**Environment:** ${run.environment}`, "");
  lines.push("## Results", "", "<!-- release-runs:results -->", "");

  for (const item of run.items) {
    lines.push(
      `### ${item.label}`,
      `<!-- release-runs:item ${encodeURIComponent(item.key)} -->`,
      "",
      `**Status:** ${item.status}`,
      "",
      item.evidence ? `**Evidence:** ${item.evidence}` : "**Evidence:**",
      ""
    );
  }

  lines.push("<!-- release-runs:end -->", "");
  return lines.join("\n");
}

function parseRun(markdown) {
  const lines = markdown.split(/\r?\n/);
  const headerEnd = lines.indexOf("---", 1);
  if (lines[0] !== "---" || headerEnd === -1) return null;
  try {
    const header = parseYaml(lines.slice(1, headerEnd).join("\n"));
    if (header?.["release-runs-schema"] !== SCHEMA) return null;
    const run = Object.fromEntries(["source", "created", "name", "version", "environment"]
      .map(key => [key, header[`release-runs-${key}`]]));
    if (![run.source, run.created, run.name, run.version, run.environment].every(value => typeof value === "string") ||
        !run.source || !run.name || !Number.isFinite(Date.parse(run.created))) return null;

    const start = lines.indexOf("<!-- release-runs:results -->", headerEnd + 1);
    const end = lines.indexOf("<!-- release-runs:end -->", start + 1);
    if (start === -1 || end === -1) return null;
    const linkLine = lines.slice(headerEnd + 1, start).find(line => line.startsWith("Source checklist: "));
    run.sourceLink = /^Source checklist: \[\[([^\]]+)\]\]$/.exec(linkLine ?? "")?.[1];
    run.items = [];
    const keys = new Set();

    for (let index = start + 1; index < end; index++) {
      const marker = ITEM_MARKER.exec(lines[index]);
      if (!marker) continue;
      const key = decodeURIComponent(marker[1]);
      const label = /^### (.+)$/.exec(lines[index - 1])?.[1];
      const status = /^\*\*Status:\*\* (.+)$/.exec(lines[index + 2])?.[1];
      const evidence = /^\*\*Evidence:\*\*(?: ([^\r\n]*))?$/.exec(lines[index + 4]);
      if (!label || !STATUSES.includes(status) || !evidence || index + 4 >= end || keys.has(key)) return null;
      keys.add(key);
      run.items.push({ key, label, status, evidence: evidence[1] ?? "", markerLine: index });
    }
    return run.items.length ? run : null;
  } catch {
    return null;
  }
}

function updateResults(markdown, edits) {
  const run = parseRun(markdown);
  if (!run) throw new Error("This note is no longer a readable Release Runs record.");
  const items = new Map(run.items.map(item => [item.key, item]));
  const lines = markdown.split(/(\r?\n)/);
  for (const { before, next } of edits) {
    const item = items.get(before.key);
    if (!item || item.label !== before.label || item.status !== before.status || item.evidence !== before.evidence) {
      throw new Error(`“${before.label}” changed while it was open. Keep a copy of your edits, then reopen the editor.`);
    }
    lines[(item.markerLine + 2) * 2] = `**Status:** ${next.status}`;
    lines[(item.markerLine + 4) * 2] = next.evidence ? `**Evidence:** ${next.evidence}` : "**Evidence:**";
  }
  return lines.join("");
}

function statusSummary(items) {
  return STATUSES.map(status => `${items.filter(item => item.status === status).length} ${status.toLowerCase()}`).join(" · ");
}

function compareRuns(previous, current) {
  const remaining = new Map(previous.items.map(item => [item.key, item]));
  const changes = [];
  for (const item of current.items) {
    const before = remaining.get(item.key);
    if (!before) {
      changes.push({ item, kind: "Added" });
      continue;
    }
    remaining.delete(item.key);
    const details = [];
    if (before.status !== item.status) details.push(`${before.status} → ${item.status}`);
    if (before.label !== item.label) details.push("Renamed");
    if (before.evidence !== item.evidence) details.push("Evidence changed");
    if (details.length) changes.push({ item, before, kind: details.join(" · ") });
  }
  for (const item of remaining.values()) changes.push({ item, kind: "Removed" });
  return changes;
}

function field(parent, caption, options) {
  const label = parent.createEl("label", { cls: "release-runs-field" });
  label.createSpan({ text: caption });
  return label.createEl("input", { type: "text", ...options });
}

function modalError(parent) {
  const el = parent.createDiv({ cls: "release-runs-error" });
  el.setAttribute("role", "alert");
  return el;
}

function action(parent, label, onClick, primary = false) {
  const button = parent.createEl("button", { text: label, attr: { type: "button" } });
  if (primary) button.addClass("mod-cta");
  button.addEventListener("click", onClick);
  return button;
}

class StartRunModal extends Modal {
  constructor(plugin, source, items) {
    super(plugin.app);
    Object.assign(this, { plugin, source, items });
  }

  onOpen() {
    this.setTitle("Start new run");
    const body = this.contentEl;
    body.addClass("release-runs-modal");
    body.createEl("p", { text: `${this.source.basename} · ${this.items.length} checklist items` });
    const form = body.createEl("form");
    const name = field(form, "Run name", { value: this.source.basename, attr: { required: "", maxlength: "150" } });
    const version = field(form, "Version or deployment URL (optional)", { attr: { maxlength: "500" } });
    const environment = field(form, "Environment (optional)", { placeholder: "For example, staging" });
    const error = modalError(form);
    const button = form.createDiv({ cls: "release-runs-actions" })
      .createEl("button", { cls: "mod-cta", text: "Create run", attr: { type: "submit" } });
    form.addEventListener("submit", async event => {
      event.preventDefault();
      if (button.disabled) return;
      const runName = name.value.trim();
      if (!runName) {
        error.textContent = "Enter a run name.";
        name.focus();
        return;
      }
      button.disabled = true;
      error.textContent = "";
      let file;
      try {
        file = await this.plugin.createRun(this.source, this.items, {
          name: runName, version: version.value.trim(), environment: environment.value.trim()
        });
      } catch (issue) {
        error.textContent = issue.message;
      } finally {
        button.disabled = false;
      }
      if (file) {
        this.close();
        await this.plugin.openCreatedRun(file);
      }
    });
    name.focus();
    name.select();
  }
}

class EvidencePicker extends FuzzySuggestModal {
  constructor(app, runFile, onPick) {
    super(app);
    this.runFile = runFile;
    this.onPick = onPick;
    this.setPlaceholder("Search for a vault file…");
  }

  getItems() {
    return this.app.vault.getFiles().filter(file => file.path !== this.runFile.path);
  }

  getItemText(file) {
    return file.path;
  }

  onChooseItem(file) {
    this.onPick(this.app.fileManager.generateMarkdownLink(file, this.runFile.path));
  }
}

class ResultsModal extends Modal {
  constructor(plugin, file, run) {
    super(plugin.app);
    Object.assign(this, { plugin, file, run });
  }

  onOpen() {
    this.setTitle("Record results");
    const body = this.contentEl;
    body.addClass("release-runs-modal");
    body.createEl("h3", { text: this.run.name });
    const details = [this.run.environment, this.run.version].filter(Boolean).join(" · ");
    if (details) body.createEl("p", { text: details });
    const summary = body.createEl("p", { text: statusSummary(this.run.items), attr: { "aria-live": "polite" } });
    const toolbarSection = body.createDiv({ cls: "release-runs-toolbar" });
    const toolbar = toolbarSection.createDiv({ cls: "release-runs-actions" });
    const pending = toolbar.createSpan({ attr: { "aria-live": "polite" } });
    const error = modalError(toolbarSection);
    const rows = [];
    let saving = false;

    const refresh = () => {
      let count = 0;
      for (const row of rows) {
        const dirty = row.isDirty();
        if (dirty) count++;
        row.button.disabled = saving || !dirty;
      }
      saveAll.disabled = saving || count === 0;
      pending.textContent = saving ? "Saving…" : count ? `${count} unsaved` : "All results saved";
    };

    const save = async selected => {
      if (saving) return;
      const edits = selected.filter(row => row.isDirty()).map(row => ({ before: row.item, next: row.draft() }));
      if (!edits.length) return;
      saving = true;
      error.textContent = "";
      refresh();
      try {
        await this.app.vault.process(this.file, content => updateResults(content, edits));
        for (const { before, next } of edits) Object.assign(before, next);
        summary.textContent = statusSummary(this.run.items);
      } catch (issue) {
        error.textContent = issue.message;
      } finally {
        saving = false;
        refresh();
      }
    };

    const saveAll = action(toolbar, "Save all results", () => save(rows), true);
    const list = body.createDiv({ cls: "release-runs-results" });
    for (const item of this.run.items) {
      const form = list.createEl("form", { cls: "release-runs-item" });
      form.createEl("h4", { text: item.label });
      const statusLabel = form.createEl("label", { cls: "release-runs-field" });
      statusLabel.createSpan({ text: "Status" });
      const status = statusLabel.createEl("select");
      for (const value of STATUSES) status.createEl("option", { text: value, value });
      status.value = item.status;
      const evidence = field(form, "Evidence", {
        value: item.evidence, placeholder: "Screenshot link, URL, or short note"
      });
      const row = form.createDiv({ cls: "release-runs-actions" });
      action(row, "Link vault file", () => {
        new EvidencePicker(this.app, this.file, link => {
          evidence.value = [evidence.value.trim(), link].filter(Boolean).join(" ");
          refresh();
        }).open();
      });
      const button = row.createEl("button", { text: "Save result", attr: { type: "submit" } });
      const draft = () => ({ status: status.value, evidence: evidence.value.trim() });
      const result = { item, button, draft, isDirty: () => status.value !== item.status || evidence.value.trim() !== item.evidence };
      rows.push(result);
      form.addEventListener("input", refresh);
      form.addEventListener("submit", event => {
        event.preventDefault();
        return save([result]);
      });
    }
    refresh();
  }
}

class ComparisonModal extends Modal {
  constructor(app, file, current, previous, sameEnvironment) {
    super(app);
    Object.assign(this, { file, current, previous, sameEnvironment });
  }

  onOpen() {
    this.setTitle(this.sameEnvironment ? "Compare runs in the same environment" : "Compare with previous run");
    const body = this.contentEl;
    body.addClass("release-runs-modal");
    const summary = body.createDiv({ cls: "release-runs-compare" });

    for (const [caption, run] of [["Previous run", this.previous], ["Current run", this.current]]) {
      const card = summary.createDiv({ cls: "release-runs-item" });
      card.createEl("h3", { text: `${caption} · ${run.name}` });
      const context = [new Date(run.created).toLocaleString(), run.environment, run.version].filter(Boolean);
      card.createEl("p", { text: context.join(" · ") });
      card.createEl("p", { text: statusSummary(run.items) });
    }

    body.createEl("h3", { text: "Changes" });
    const changes = compareRuns(this.previous, this.current);
    if (changes.length === 0) body.createEl("p", { text: "No changes in checklist items, status, or evidence." });
    const list = body.createDiv({ cls: "release-runs-results" });
    for (const { item, kind, before } of changes) {
      const row = list.createDiv({ cls: "release-runs-item" });
      row.createEl("h4", { text: item.label });
      row.createEl("p", { text: before ? kind : `${kind} · ${item.status}` });
      if (before && before.evidence !== item.evidence) {
        row.createEl("p", { text: `Previous evidence: ${before.evidence || "None"}` });
        row.createEl("p", { text: `Current evidence: ${item.evidence || "None"}` });
      }
    }

    const previousFailures = this.previous.items.filter(item => item.status === "Failed");
    if (previousFailures.length) {
      const details = body.createEl("details");
      details.createEl("summary", { text: `Previous failures (${previousFailures.length})` });
      const failures = details.createEl("ul");
      for (const item of previousFailures) failures.createEl("li", { text: item.label });
    }

    action(body.createDiv({ cls: "release-runs-actions" }), "Open previous run", async () => {
      try {
        await this.app.workspace.getLeaf(false).openFile(this.file);
        this.close();
      } catch (issue) {
        new Notice(`Release Runs: ${issue.message}`);
      }
    });
  }
}

module.exports = class ReleaseRunsPlugin extends Plugin {
  onload() {
    this.addCommand({
      id: "start-run",
      name: "Start new run",
      editorCallback: (editor, view) => this.launch(() => this.startRun(view.file, editor.getValue()))
    });

    this.addCommand({
      id: "record-results",
      name: "Record results",
      checkCallback: checking => this.runCommand(checking, async (file, run) => {
        new ResultsModal(this, file, run).open();
      })
    });

    this.addCommand({
      id: "compare-previous-run",
      name: "Compare with previous run",
      checkCallback: checking => this.runCommand(checking, (file, run) => this.openComparison(file, run))
    });

    this.addCommand({
      id: "compare-same-environment",
      name: "Compare with previous run in the same environment",
      checkCallback: checking => this.runCommand(checking, (file, run) => this.openComparison(file, run, true))
    });

    this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
      if (!(file instanceof TFile) || file.extension !== "md") return;
      if (this.isRunFile(file)) {
        menu.addItem(item => item.setTitle("Record run results").setIcon("list-checks")
          .onClick(() => this.launch(async () => {
            const run = await this.readRun(file);
            new ResultsModal(this, file, run).open();
          })));
      } else {
        menu.addItem(item => item.setTitle("Start checklist run").setIcon("list-checks")
          .onClick(() => this.launch(async () => this.startRun(file, await this.app.vault.read(file)))));
      }
    }));
  }

  launch(callback) {
    void Promise.resolve().then(callback).catch(issue => new Notice(`Release Runs: ${issue.message}`));
  }

  isRunFile(file) {
    return this.app.metadataCache.getFileCache(file)?.frontmatter?.["release-runs-schema"] === SCHEMA ||
      file.path.startsWith(`${RUNS_FOLDER}/`);
  }

  runCommand(checking, callback) {
    const file = this.app.workspace.getActiveFile();
    if (!file || !this.isRunFile(file)) return false;
    if (!checking) this.launch(async () => callback(file, await this.readRun(file)));
    return true;
  }

  startRun(file, content) {
    if (!file || parseRun(content)) throw new Error("Open the original checklist to start a new run.");
    const items = checklistItems(content);
    if (!items.length) throw new Error("No Markdown checklist items found in this note.");
    new StartRunModal(this, file, items).open();
  }

  async createRun(source, items, details) {
    const vault = this.app.vault;
    if (!vault.getAbstractFileByPath(RUNS_FOLDER)) {
      try {
        await vault.createFolder(RUNS_FOLDER);
      } catch (issue) {
        if (!(vault.getAbstractFileByPath(RUNS_FOLDER) instanceof TFolder)) throw issue;
      }
    }
    if (!(vault.getAbstractFileByPath(RUNS_FOLDER) instanceof TFolder)) {
      throw new Error(`"${RUNS_FOLDER}" must be a folder.`);
    }
    const created = new Date().toISOString();
    const safeName = Array.from(details.name.replace(/[\x00-\x1f<>:"/\\|?*#[\]]/g, "-")).slice(0, 50).join("")
      .replace(/[ .]+$/g, "") || "Checklist";
    const stamp = created.replace(/[:.]/g, "-");
    const base = `${RUNS_FOLDER}/${stamp} ${safeName}`;
    const content = runDocument({ ...details, source: source.path, created, items });
    for (let suffix = 1; suffix <= 100; suffix++) {
      const path = `${base}${suffix === 1 ? "" : ` (${suffix})`}.md`;
      if (vault.getAbstractFileByPath(path)) continue;
      try {
        return await vault.create(path, content);
      } catch (issue) {
        if (!vault.getAbstractFileByPath(path)) throw issue;
      }
    }
    throw new Error("Unable to choose a unique run filename. Try again.");
  }

  async openCreatedRun(file) {
    try {
      await this.app.workspace.getLeaf(false).openFile(file);
      const run = await this.readRun(file);
      new ResultsModal(this, file, run).open();
    } catch (issue) {
      new Notice(`Run saved at ${file.path}. ${issue.message}`);
    }
  }

  async readRun(file) {
    const run = parseRun(await this.app.vault.read(file));
    if (!run) throw new Error("This note is not a readable Release Runs record.");
    return run;
  }

  sourceIdentity(file, run) {
    const target = run.sourceLink && this.app.metadataCache.getFirstLinkpathDest(run.sourceLink, file.path);
    return target?.path ?? run.source;
  }

  async openComparison(file, current, sameEnvironment = false) {
    const previous = await this.previousRun(file, current, sameEnvironment);
    if (!previous) {
      const environment = current.environment.trim();
      const scope = sameEnvironment ? (environment ? ` in ${environment}` : " without an environment") : "";
      new Notice(`Release Runs: no earlier run for this checklist${scope}.`);
      return;
    }
    new ComparisonModal(this.app, previous.file, current, previous.run, sameEnvironment).open();
  }

  async previousRun(file, current, sameEnvironment = false) {
    const source = this.sourceIdentity(file, current);
    const candidates = this.app.vault.getMarkdownFiles()
      .filter(candidate => candidate.path !== file.path && this.isRunFile(candidate));
    let previous = null;
    const currentTime = Date.parse(current.created);
    const environment = current.environment.trim().toLowerCase();

    for (const candidate of candidates) {
      const run = parseRun(await this.app.vault.cachedRead(candidate));
      if (!run || this.sourceIdentity(candidate, run) !== source) continue;
      if (sameEnvironment && run.environment.trim().toLowerCase() !== environment) continue;
      const time = Date.parse(run.created);
      if (time > currentTime || (time === currentTime && candidate.path >= file.path)) continue;
      if (!previous || time > previous.time || (time === previous.time && candidate.path > previous.file.path)) {
        previous = { file: candidate, run, time };
      }
    }
    return previous;
  }
};
