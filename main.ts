import { App, FrontMatterCache, Notice, Plugin, PluginSettingTab, Setting, TAbstractFile, TFile, parseYaml } from 'obsidian';

/*************************************************
 * PDF‑View‑Sync — persist the last‑read page of  *
 * every PDF in the YAML front‑matter of a buddy  *
 * markdown note and restore it next time.        *
 *                                               *
 * v2 — fixes                                     *
 *   • front‑matter never updating                *
 *   • page never restoring                       *
 *                                               *
 *   Key changes                                  *
 *   1. always add freshly‑opened PDFs to         *
 *      openPDFs so they actually get saved       *
 *   2. use fileManager.processFrontMatter()      *
 *   3. save on every pagechange event emitted    *
 *      by the internal PDF.js viewer            *
 *   4. simpler wait‑until‑ready logic            *
 *************************************************/

interface Settings {
  associatedNoteTemplate: string;
  frontmatterKey: string;
  enableStateSaving: boolean;
  enableStateLoading: boolean;
  createAssociatedNote: boolean;
}

const DEFAULT_SETTINGS: Settings = {
  associatedNoteTemplate: '@{{pdf_basename}}.md',
  frontmatterKey: 'pdf-view-state',
  enableStateSaving: true,
  enableStateLoading: true,
  createAssociatedNote: false,
};

interface PDFView {
  file: TFile;
  getState(): { page: number };
  setState(state: { page: number }, result: any): Promise<void>;
  containerEl: HTMLElement;
}

export default class PDFViewSyncPlugin extends Plugin {
  settings!: Settings;
  private openPDFs = new Map<string, PDFView>();
  private LAST_SAVE = 0;

  /* ─────────────────────────── lifecycle */

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new SettingTab(this.app, this));

    // 1️⃣ track every PDF we open so autosave hits it
    this.registerEvent(
      this.app.workspace.on('file-open', (file) => {
        if (file instanceof TFile && file.extension === 'pdf') {
          const view = this.getActivePDFView();
          if (view) this.openPDFs.set(file.path, view);
          this.restorePage(file);
        }
      }),
    );

    // 2️⃣ save when we leave a PDF view
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', (leaf) => {
        if (leaf && leaf.view && !this.isPDFView(leaf.view)) this.saveAll();
      }),
    );

    // 3️⃣ periodic safety‑save
    this.registerInterval(window.setInterval(() => this.saveAll(), 20_000));

    console.log('PDF‑View‑Sync loaded');
  }

  onunload() {
    this.saveAll();
  }

  /* ─────────────────────────── helpers */

  private isPDFView(v: any): v is PDFView {
    return v && v.file && v.file.extension === 'pdf';
  }

  private getActivePDFView(): PDFView | null {
    const leaf = this.app.workspace.activeLeaf;
    return leaf && this.isPDFView(leaf.view) ? (leaf.view as PDFView) : null;
  }

  /* ─────────────────────────── restore */

  private async restorePage(file: TFile) {
    if (!this.settings.enableStateLoading) return;

    const pdfView = this.getActivePDFView();
    if (!pdfView) return;

    const notePath = this.getAssociatedNotePath(file.path);
    if (!notePath) return;

    const note = this.app.vault.getAbstractFileByPath(notePath);
    if (!(note instanceof TFile)) return;

    let fm: FrontMatterCache | undefined | null = this.app.metadataCache.getCache(notePath)?.frontmatter;
    if (!fm) {
      const txt = await this.app.vault.read(note);
      const m = txt.match(/^---\n([\s\S]*?)\n---/);
      if (m) fm = parseYaml(m[1]);
    }

    if (!fm || fm[this.settings.frontmatterKey] == null) return;

    const raw = fm[this.settings.frontmatterKey];
    const page = typeof raw === 'number' ? raw : raw?.page;
    if (typeof page !== 'number') return;

    await this.waitUntilPDFReady(pdfView);
    await pdfView.setState({ page }, {});
    new Notice(`Restored to page ${page}`);
  }

  private async waitUntilPDFReady(pdfView: PDFView) {
    /* The builtin viewer fires a custom "pagechange" event once the
       first render finishes.  Hook it instead of polling. */
    if ((pdfView.containerEl as any).__pdfSyncReady) return; // already waited once

    await new Promise<void>((res) => {
      const listener = () => {
        pdfView.containerEl.removeEventListener('pagechange', listener);
        (pdfView.containerEl as any).__pdfSyncReady = true;
        res();
      };
      pdfView.containerEl.addEventListener('pagechange', listener, { once: true });
    });
  }

  /* ─────────────────────────── save */

  private saveAll() {
    if (!this.settings.enableStateSaving) return;
    const now = Date.now();
    // throttle to once every 5 s overall so heavy scrolling doesn’t spam disk
    if (now - this.LAST_SAVE < 5000) return;
    this.LAST_SAVE = now;

    for (const v of this.openPDFs.values()) this.saveOne(v);
  }

  private async saveOne(pdfView: PDFView) {
    const state = pdfView.getState();
    if (!state || typeof state.page !== 'number') return;

    const notePath = this.getAssociatedNotePath(pdfView.file.path);
    if (!notePath) return;

    let note = this.app.vault.getAbstractFileByPath(notePath);
    if (!(note instanceof TFile)) {
      if (!this.settings.createAssociatedNote) return;
      note = await this.app.vault.create(notePath, `---\n${this.settings.frontmatterKey}: ${state.page}\n---\n\n`);
    }

    try {
      await this.app.fileManager.processFrontMatter(note, (fm) => {
        fm[this.settings.frontmatterKey] = state.page;
      });
    } catch (e) {
      console.error('[PDF‑View‑Sync] front‑matter write failed', e);
    }
  }

  /* ─────────────────────────── path helpers */

  private getAssociatedNotePath(pdfPath: string): string | null {
    try {
      const f = this.app.vault.getAbstractFileByPath(pdfPath);
      if (!(f instanceof TFile)) return null;

      const pdfFilename = f.name;
      const pdfBasename = pdfFilename.replace(/\.pdf$/i, '');
      const pdfFolderPath = f.parent ? f.parent.path : '';
      const pdfParentFolder = f.parent ? f.parent.name : '';

      let p = this.settings.associatedNoteTemplate
        .replace(/{{pdf_filename}}/g, pdfFilename)
        .replace(/{{pdf_basename}}/g, pdfBasename)
        .replace(/{{pdf_folder_path}}/g, pdfFolderPath)
        .replace(/{{pdf_parent_folder_name}}/g, pdfParentFolder);

      return p.startsWith('/') ? p.slice(1) : p;
    } catch (e) {
      console.error('[PDF‑View‑Sync] path error', e);
      return null;
    }
  }

  /* ─────────────────────────── settings */

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

class SettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: PDFViewSyncPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'PDF‑View‑Sync' });

    new Setting(containerEl)
      .setName('Associated Note Path Template')
      .addText((t) =>
        t
          .setPlaceholder('@{{pdf_basename}}.md')
          .setValue(this.plugin.settings.associatedNoteTemplate)
          .onChange(async (v) => {
            this.plugin.settings.associatedNoteTemplate = v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Front‑matter key')
      .addText((t) =>
        t
          .setPlaceholder('pdf-view-state')
          .setValue(this.plugin.settings.frontmatterKey)
          .onChange(async (v) => {
            this.plugin.settings.frontmatterKey = v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Enable saving')
      .addToggle((tog) => tog.setValue(this.plugin.settings.enableStateSaving).onChange(async (v) => {
        this.plugin.settings.enableStateSaving = v;
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName('Enable loading')
      .addToggle((tog) => tog.setValue(this.plugin.settings.enableStateLoading).onChange(async (v) => {
        this.plugin.settings.enableStateLoading = v;
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName('Create associated note if missing')
      .addToggle((tog) => tog.setValue(this.plugin.settings.createAssociatedNote).onChange(async (v) => {
        this.plugin.settings.createAssociatedNote = v;
        await this.plugin.saveSettings();
      }));
  }
}

