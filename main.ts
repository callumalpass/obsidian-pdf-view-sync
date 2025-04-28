import { App, FrontMatterCache, Notice, Plugin, PluginSettingTab, Setting, TAbstractFile, TFile, parseYaml } from 'obsidian';

interface PDFViewSyncSettings {
	associatedNoteTemplate: string;
	frontmatterKey: string;
	enableStateSaving: boolean;
	enableStateLoading: boolean;
	createAssociatedNote: boolean;
}

const DEFAULT_SETTINGS: PDFViewSyncSettings = {
	associatedNoteTemplate: '@{{pdf_basename}}.md',
	frontmatterKey: 'pdf-view-state',
	enableStateSaving: true,
	enableStateLoading: true,
	createAssociatedNote: false,
};

// Bare-bones interface for Obsidian's internal PDF view
interface PDFView {
	file: TFile;
	getState(): { page: number };
	setState(state: { page: number }, result: any): Promise<void>;
}

export default class PDFViewSyncPlugin extends Plugin {
	settings: PDFViewSyncSettings;
	// Keep track of open PDFs so we can flush them on close/unload
	private openPDFs: Map<string, PDFView> = new Map();

	async onload() {
		await this.loadSettings();

		this.addSettingTab(new PDFViewSyncSettingTab(this.app, this));

		// Restore state when a PDF is opened
		this.registerEvent(
			this.app.workspace.on('file-open', (file) => this.handleFileOpen(file)),
		);

		// Detect leaves that disappear (PDF closed) and persist state
		this.registerEvent(
			this.app.workspace.on('layout-change', () => this.checkForClosedPDFs()),
		);

		// Persist when we switch away from a PDF
		this.registerEvent(
			this.app.workspace.on('active-leaf-change', (leaf) => {
				if (leaf && leaf.view && !this.isPDFView(leaf.view)) this.saveAllPDFStates();
			}),
		);

		// Autosave every 30 s
		this.registerInterval(window.setInterval(() => this.saveAllPDFStates(), 30_000));

		// Populate openPDFs after initial layout
		this.app.workspace.onLayoutReady(() => this.trackOpenPDFs());

		console.log('PDF View Sync plugin loaded');
	}

	// --------------  helpers --------------

	private isPDFView(view: any): view is PDFView {
		return view && view.file && view.file.extension === 'pdf';
	}

	private getActivePDFView(): PDFView | null {
		const leaf = this.app.workspace.activeLeaf;
		return leaf && this.isPDFView(leaf.view) ? (leaf.view as PDFView) : null;
	}

	private async waitForPDFReady(pdfView: PDFView): Promise<void> {
		// Poll until Obsidian has rendered the PDF and getState() stops returning page 1
		for (let i = 0; i < 20; i++) {
			const s = pdfView.getState();
			if (s && s.page && s.page > 1) return;
			await new Promise((r) => setTimeout(r, 100));
		}
	}

	private saveAllPDFStates() {
		for (const pdfView of this.openPDFs.values()) this.savePDFState(pdfView);
	}

	private trackOpenPDFs() {
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (this.isPDFView(leaf.view)) {
				const v = leaf.view as PDFView;
				this.openPDFs.set(v.file.path, v);
			}
		});
	}

	private checkForClosedPDFs() {
		const stillOpen = new Set<string>();
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (this.isPDFView(leaf.view)) stillOpen.add((leaf.view as PDFView).file.path);
		});

		for (const [p, v] of this.openPDFs.entries()) {
			if (!stillOpen.has(p)) {
				this.savePDFState(v);
				this.openPDFs.delete(p);
			}
		}

		// add new ones
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (this.isPDFView(leaf.view)) {
				const v = leaf.view as PDFView;
				if (!this.openPDFs.has(v.file.path)) this.openPDFs.set(v.file.path, v);
			}
		});
	}

	// --------------  main logic --------------

	async handleFileOpen(file: TAbstractFile | null) {
		if (!this.settings.enableStateLoading || !file || !(file instanceof TFile) || file.extension !== 'pdf') return;

		const pdfView = this.getActivePDFView();
		if (!pdfView) return;

		try {
			const notePath = this.getAssociatedNotePath(file.path);
			if (!notePath) return;

			const note = this.app.vault.getAbstractFileByPath(notePath);
			if (!note || !(note instanceof TFile)) return;

			// Try cache first
			let front: FrontMatterCache | null | undefined = this.app.metadataCache.getCache(notePath)?.frontmatter;

			if (!front) {
				// fall back to manual parse (rare)
				const raw = await this.app.vault.read(note);
				const m = raw.match(/^---\n([\s\S]*?)\n---/);
				if (m) front = parseYaml(m[1]);
			}

			if (!front || front[this.settings.frontmatterKey] === undefined) return;

			const value = front[this.settings.frontmatterKey];
			const page = typeof value === 'number' ? value : value?.page;
			if (typeof page !== 'number') return;

			await this.waitForPDFReady(pdfView);
			await pdfView.setState({ page }, {});
			new Notice(`Restored to page ${page}`);
		} catch (err) {
			console.error('Failed to restore PDF state:', err);
		}
	}

	async savePDFState(pdfView: PDFView) {
		if (!this.settings.enableStateSaving) return;

		const current = pdfView.getState();
		if (!current || typeof current.page !== 'number') return;

		const notePath = this.getAssociatedNotePath(pdfView.file.path);
		if (!notePath) return;

		let note = this.app.vault.getAbstractFileByPath(notePath);

		// Optionally create the note first time
		if (!note || !(note instanceof TFile)) {
			if (!this.settings.createAssociatedNote) return;
			note = await this.app.vault.create(notePath, `---\n${this.settings.frontmatterKey}: ${current.page}\n---\n\n`);
			return;
		}

		try {
			await this.app.fileManager.processFrontMatter(note, (fm) => {
				fm[this.settings.frontmatterKey] = current.page;
			});
		} catch (err) {
			console.error('Error writing front-matter:', err);
		}
	}

	private getAssociatedNotePath(pdfPath: string): string | null {
		try {
			const f = this.app.vault.getAbstractFileByPath(pdfPath);
			if (!f || !(f instanceof TFile)) return null;

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
			console.error('Path calc error:', e);
			return null;
		}
	}

	onunload() {
		for (const v of this.openPDFs.values()) this.savePDFState(v);
		console.log('PDF View Sync plugin unloaded');
	}

	// --------------  settings I/O --------------

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class PDFViewSyncSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: PDFViewSyncPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('h2', { text: 'PDF View State Sync Settings' });

		new Setting(containerEl)
			.setName('Associated Note Path Template')
			.setDesc('Placeholders: {{pdf_filename}}, {{pdf_basename}}, {{pdf_folder_path}}, {{pdf_parent_folder_name}}')
			.addText((t) =>
				t.setPlaceholder('@{{pdf_basename}}.md')
				.setValue(this.plugin.settings.associatedNoteTemplate)
				.onChange(async (v) => {
					this.plugin.settings.associatedNoteTemplate = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('Front-matter Key')
			.setDesc('YAML key used to store the page number')
			.addText((t) =>
				t.setPlaceholder('pdf-view-state')
				.setValue(this.plugin.settings.frontmatterKey)
				.onChange(async (v) => {
					this.plugin.settings.frontmatterKey = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('Enable State Saving')
			.addToggle((tog) =>
				tog.setValue(this.plugin.settings.enableStateSaving).onChange(async (v) => {
					this.plugin.settings.enableStateSaving = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('Enable State Loading')
			.addToggle((tog) =>
				tog.setValue(this.plugin.settings.enableStateLoading).onChange(async (v) => {
					this.plugin.settings.enableStateLoading = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('Create Associated Note')
			.setDesc('Automatically create the note if it is missing')
			.addToggle((tog) =>
				tog.setValue(this.plugin.settings.createAssociatedNote).onChange(async (v) => {
					this.plugin.settings.createAssociatedNote = v;
					await this.plugin.saveSettings();
				}),
			);
	}
}
