import { App, Editor, FrontMatterCache, MarkdownView, Notice, Plugin, PluginSettingTab, Setting, TAbstractFile, TFile, parseYaml, stringifyYaml } from 'obsidian';

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
	createAssociatedNote: false
}

// Type for PDF view, which is not directly exposed in the Obsidian API types
interface PDFView {
	file: TFile;
	getState(): { page: number };
	setState(state: { page: number }, result: any): Promise<void>;
}

export default class PDFViewSyncPlugin extends Plugin {
	settings: PDFViewSyncSettings;

	async onload() {
		await this.loadSettings();

		// Register the settings tab
		this.addSettingTab(new PDFViewSyncSettingTab(this.app, this));

		// Register event handlers for loading and saving PDF view state
		this.registerEvent(
			this.app.workspace.on('file-open', (file) => {
				this.handleFileOpen(file);
			})
		);

		// Monitor when PDFs are closed
		this.registerEvent(
			this.app.workspace.on('layout-change', () => {
				this.checkForClosedPDFs();
			})
		);

		// Keep track of open PDF views
		this.app.workspace.onLayoutReady(() => {
			this.trackOpenPDFs();
		});

		console.log('PDF View Sync plugin loaded');
	}

	// Store the PDFs that are currently open
	private openPDFs: Map<string, any> = new Map();

	private trackOpenPDFs() {
		this.app.workspace.iterateAllLeaves(leaf => {
			const view = leaf.view as any;
			if (this.isPDFView(view)) {
				const file = view.file;
				if (file) {
					this.openPDFs.set(file.path, view);
				}
			}
		});
	}

	private checkForClosedPDFs() {
		// Create a set of currently open PDF files
		const currentPDFs = new Set<string>();
		
		this.app.workspace.iterateAllLeaves(leaf => {
			const view = leaf.view as any;
			if (this.isPDFView(view) && view.file) {
				currentPDFs.add(view.file.path);
			}
		});

		// Check which PDFs have been closed
		for (const [pdfPath, pdfView] of this.openPDFs.entries()) {
			if (!currentPDFs.has(pdfPath)) {
				// PDF was closed, save its state
				this.savePDFState(pdfView);
				this.openPDFs.delete(pdfPath);
			}
		}

		// Add any newly opened PDFs
		this.app.workspace.iterateAllLeaves(leaf => {
			const view = leaf.view as any;
			if (this.isPDFView(view) && view.file) {
				if (!this.openPDFs.has(view.file.path)) {
					this.openPDFs.set(view.file.path, view);
				}
			}
		});
	}

	private isPDFView(view: any): boolean {
		// Check if this is a PDF view by examining its prototype chain
		return view && view.file && view.file.extension === 'pdf';
	}

	async handleFileOpen(file: TAbstractFile | null) {
		if (!this.settings.enableStateLoading || !file || !(file instanceof TFile) || file.extension !== 'pdf') {
			return;
		}

		// Get the active PDF view
		const pdfView = this.getActivePDFView();
		if (!pdfView) {
			return;
		}

		try {
			// Get the associated note path
			const associatedNotePath = this.getAssociatedNotePath(file.path);
			if (!associatedNotePath) {
				return;
			}

			// Check if the associated note exists
			const associatedNote = this.app.vault.getAbstractFileByPath(associatedNotePath);
			if (!associatedNote || !(associatedNote instanceof TFile)) {
				console.log(`Associated note not found for ${file.path}`);
				return;
			}

			// Try to get the frontmatter from metadata cache first (faster)
			let frontmatter: FrontMatterCache | null = null;
			const cache = this.app.metadataCache.getCache(associatedNotePath);
			if (cache && cache.frontmatter) {
				frontmatter = cache.frontmatter;
			} else {
				// Read file and parse frontmatter
				const content = await this.app.vault.read(associatedNote);
				const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
				if (frontmatterMatch) {
					try {
						frontmatter = parseYaml(frontmatterMatch[1]);
					} catch (e) {
						console.error("Error parsing frontmatter:", e);
					}
				}
			}

			// Check if we have frontmatter and the PDF state key
			if (frontmatter && frontmatter[this.settings.frontmatterKey]) {
				const pdfState = frontmatter[this.settings.frontmatterKey];
				const pageNumber = typeof pdfState === 'number' ? pdfState : 
					(typeof pdfState === 'object' && pdfState.page !== undefined ? pdfState.page : null);
				
				if (pageNumber !== null) {
					// Set the PDF view state
					await pdfView.setState({ page: pageNumber }, {});
					console.log(`Restored PDF state for ${file.path} to page ${pageNumber}`);
				}
			}
		} catch (error) {
			console.error(`Error loading PDF state for ${file.path}:`, error);
		}
	}

	async savePDFState(pdfView: any) {
		if (!this.settings.enableStateSaving || !pdfView || !pdfView.file) {
			return;
		}

		try {
			const pdfFilePath = pdfView.file.path;
			
			// Get current state (page number)
			const currentState = pdfView.getState();
			if (!currentState || currentState.page === undefined) {
				console.log(`Could not get state for ${pdfFilePath}`);
				return;
			}

			// Calculate associated note path
			const associatedNotePath = this.getAssociatedNotePath(pdfFilePath);
			if (!associatedNotePath) {
				return;
			}

			// Check if the associated note exists
			let associatedNote = this.app.vault.getAbstractFileByPath(associatedNotePath);
			if (!associatedNote || !(associatedNote instanceof TFile)) {
				// Create the note if the setting is enabled
				if (this.settings.createAssociatedNote) {
					try {
						await this.app.vault.create(associatedNotePath, `---\n${this.settings.frontmatterKey}: ${currentState.page}\n---\n\n`);
						new Notice(`Created note for PDF: ${associatedNotePath}`);
						return;
					} catch (error) {
						console.error(`Error creating associated note ${associatedNotePath}:`, error);
						return;
					}
				} else {
					console.log(`Associated note not found for ${pdfFilePath}`);
					return;
				}
			}

			// Read the content of the associated note
			const content = await this.app.vault.read(associatedNote as TFile);
			
			// Check if the note has frontmatter
			const frontmatterRegex = /^---\n([\s\S]*?)\n---/;
			const frontmatterMatch = content.match(frontmatterRegex);
			
			let newContent: string;
			
			if (frontmatterMatch) {
				// Parse existing frontmatter
				try {
					const frontmatter = parseYaml(frontmatterMatch[1]);
					// Update the PDF state
					frontmatter[this.settings.frontmatterKey] = currentState.page;
					// Reconstruct the content with updated frontmatter
					const updatedFrontmatter = stringifyYaml(frontmatter);
					newContent = content.replace(frontmatterRegex, `---\n${updatedFrontmatter}---`);
				} catch (e) {
					console.error("Error parsing frontmatter:", e);
					// If we can't parse the frontmatter, add our state at the end of it
					const existingFrontmatter = frontmatterMatch[1];
					const updatedFrontmatter = `${existingFrontmatter}\n${this.settings.frontmatterKey}: ${currentState.page}`;
					newContent = content.replace(frontmatterRegex, `---\n${updatedFrontmatter}\n---`);
				}
			} else {
				// No frontmatter exists, add it
				newContent = `---\n${this.settings.frontmatterKey}: ${currentState.page}\n---\n\n${content}`;
			}
			
			// Write the modified content back to the file
			await this.app.vault.modify(associatedNote as TFile, newContent);
			console.log(`Saved PDF state for ${pdfFilePath} at page ${currentState.page}`);
			
		} catch (error) {
			console.error("Error saving PDF state:", error);
		}
	}

	private getActivePDFView(): PDFView | null {
		// Find the active PDF view by iterating through leaves
		let activePDFView: PDFView | null = null;
		
		const activeLeaf = this.app.workspace.activeLeaf;
		if (activeLeaf && activeLeaf.view && this.isPDFView(activeLeaf.view)) {
			activePDFView = activeLeaf.view as unknown as PDFView;
		}
		
		return activePDFView;
	}

	private getAssociatedNotePath(pdfFilePath: string): string | null {
		try {
			const pdfFile = this.app.vault.getAbstractFileByPath(pdfFilePath);
			if (!pdfFile || !(pdfFile instanceof TFile)) {
				return null;
			}

			// Extract information from the PDF file path
			const pdfFilename = pdfFile.name;
			const pdfBasename = pdfFilename.replace(/\.pdf$/i, '');
			const pdfFolderPath = pdfFile.parent ? pdfFile.parent.path : '';
			const pdfParentFolderName = pdfFile.parent ? pdfFile.parent.name : '';

			// Replace placeholders in the template
			let associatedNotePath = this.settings.associatedNoteTemplate
				.replace(/{{pdf_filename}}/g, pdfFilename)
				.replace(/{{pdf_basename}}/g, pdfBasename)
				.replace(/{{pdf_folder_path}}/g, pdfFolderPath)
				.replace(/{{pdf_parent_folder_name}}/g, pdfParentFolderName);

			// Always treat the template as an absolute path from the vault root
			// If it doesn't start with '/', add it to make it absolute
			if (!associatedNotePath.startsWith('/')) {
				associatedNotePath = `/${associatedNotePath}`;
			}

			return associatedNotePath;
		} catch (error) {
			console.error("Error calculating associated note path:", error);
			return null;
		}
	}

	onunload() {
		// Save state for any open PDFs when the plugin is unloaded
		for (const pdfView of this.openPDFs.values()) {
			this.savePDFState(pdfView);
		}
		console.log('PDF View Sync plugin unloaded');
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class PDFViewSyncSettingTab extends PluginSettingTab {
	plugin: PDFViewSyncPlugin;

	constructor(app: App, plugin: PDFViewSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();

		containerEl.createEl('h2', {text: 'PDF View State Sync Settings'});

		new Setting(containerEl)
			.setName('Associated Note Path Template')
			.setDesc('Template for locating/creating the associated note. Placeholders: {{pdf_filename}}, {{pdf_basename}}, {{pdf_folder_path}}, {{pdf_parent_folder_name}}')
			.addText(text => text
				.setPlaceholder('@{{pdf_basename}}.md')
				.setValue(this.plugin.settings.associatedNoteTemplate)
				.onChange(async (value) => {
					this.plugin.settings.associatedNoteTemplate = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Frontmatter Key')
			.setDesc('The key name under which the PDF state will be stored in the associated note\'s frontmatter')
			.addText(text => text
				.setPlaceholder('pdf-view-state')
				.setValue(this.plugin.settings.frontmatterKey)
				.onChange(async (value) => {
					this.plugin.settings.frontmatterKey = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Enable State Saving')
			.setDesc('Master switch to enable/disable the saving feature')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableStateSaving)
				.onChange(async (value) => {
					this.plugin.settings.enableStateSaving = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Enable State Loading')
			.setDesc('Master switch to enable/disable the loading feature')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableStateLoading)
				.onChange(async (value) => {
					this.plugin.settings.enableStateLoading = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Create Associated Note')
			.setDesc('If enabled, the plugin will create the associated note if it doesn\'t exist when trying to save state')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.createAssociatedNote)
				.onChange(async (value) => {
					this.plugin.settings.createAssociatedNote = value;
					await this.plugin.saveSettings();
				}));
	}
}