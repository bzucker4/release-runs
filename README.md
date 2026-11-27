# Release Runs

Turn a Markdown checklist into a fresh test run, record results with evidence, and compare it with the previous run from the same checklist. Run records are readable Markdown notes in your vault.

## Install manually

1. Open the vault folder on your device.
2. Copy the `release-runs` folder into `.obsidian/plugins/` inside the vault. Check that `.obsidian/plugins/release-runs/manifest.json`, `main.js`, and `styles.css` are present.
3. Reload Obsidian and enable **Release Runs** under **Settings → Community plugins**. The manifest targets Obsidian 1.5.0 or later.

## Run a checklist

Create a Markdown note with a checklist, for example:

```markdown
- [ ] The setup instructions work from a clean install ^setup
- [ ] A completed run remains readable in Reading view ^reading
- [ ] Previous results open from the comparison view ^comparison
```

1. Open that note and choose **Release Runs: Start new run** from the command palette. You can also right-click the checklist note in the file explorer and choose **Start checklist run**.
2. Enter a run name and optional version, deployment URL, or environment. **Create run** writes a dated note in the **Release Runs** folder and opens the result editor. All checks start **Untested**, including checks marked complete in the template.
3. Set a result and click **Save result**, or edit several items and click **Save all results**. For evidence, enter an observation or URL. **Link vault file** opens a search for existing screenshots, notes, and other vault files and appends the selected link to the evidence. You can reopen the result editor with **Release Runs: Record results**.
4. Open a later run for the same checklist and select **Release Runs: Compare with previous run**. Use **Release Runs: Compare with previous run in the same environment** to find the last run with a matching environment label. The comparison shows changes in checklist items, status, and evidence. Open the previous note to inspect its saved results.

The comparison matches unchanged checklist text. Add a unique Obsidian block ID such as `^setup` to an item to track it through wording changes. If you move or rename a checklist, let Obsidian update its internal links so related runs stay associated. The results editor preserves notes you add outside the results section.

Release Runs works with local Markdown and does not contact a server. It records results you enter and links to evidence you provide.

## Verify changes

From the repository root, run `node --check main.js` and `node --test` with Node.js 22 or later. The automated tests exercise the workflow with a simulated Obsidian API.

For an in-app check, install the plugin in a test vault. Create three runs from one checklist in this order: production, staging, production. Save a different result with evidence in each run. From the most recent run, verify that the default command selects staging and the same-environment command selects the earlier production run. Confirm that the evidence link opens in Reading view.

In one run, change two results and use **Link vault file** to add a screenshot to one of them. Choose **Save all results**, reopen the run, and confirm that both results and the link persisted.

## Support

Built by Atlas Creative. [Sponsor bzucker4 on GitHub](https://github.com/sponsors/bzucker4).

## Release and license

Release Runs is licensed under the [MIT License](LICENSE).

For a new release, update `manifest.json` and `versions.json` on the default branch and run **Publish Obsidian release** from the repository’s Actions tab. The workflow runs the tests and uses the manifest version as the GitHub release tag. It attaches `main.js`, `manifest.json`, and `styles.css` separately so Obsidian can install them.
