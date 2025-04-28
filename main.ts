import {
	Plugin,
	WorkspaceLeaf,
	TFile,
	TAbstractFile,
	normalizePath,
	Notice,
	MetadataCache,
	Vault,
	Workspace,
	View,
	FileView,
	App,
	EventRef,
	FileManager,
	Component
} from 'obsidian';

import { PdfSyncSettings, DEFAULT_SETTINGS, PdfSyncSettingTab } from './settings';

// Augment Workspace for 'quit' event
declare module 'obsidian' {
	interface Workspace {
		on( name: 'active-leaf-change', callback: (leaf: WorkspaceLeaf | null, oldLeaf: WorkspaceLeaf | null) => any, ctx?: any ): EventRef;
		on(name: 'quit', callback: (tasks?: any) => any, ctx?: any): EventRef;
	}
}

// --- Helper Functions ---
function getBasePath(fullPath: string): string {
	const parts = fullPath.split('/');
	parts.pop(); // Remove filename
	return parts.join('/') || '/';
}

function getParentFolderName(fullPath: string): string {
	const parts = fullPath.split('/');
	if (parts.length < 2) return '';
	return parts[parts.length - 2];
}

// --- PDF View Type Guard and Interface ---
interface PdfView extends FileView {
	file: TFile; // Assert non-nullable for our use case
	getState(): any;
	setState(state: any, options?: any): Promise<void>;
	getEphemeralState(): any;
}

// Robust type guard
function isPdfView(view: View | null | undefined): view is PdfView {
	if (!view) { return false; }
	if (view.getViewType() !== 'pdf') { return false; }
	if (!('file' in view && 'getState' in view && 'setState' in view)) { return false; }
	const file = (view as FileView).file;
	if (!(file instanceof TFile)) { return false; }
	return file.extension.toLowerCase() === 'pdf';
}

// --- Plugin Class ---
export default class PdfViewStateSyncPlugin extends Plugin {
	settings: PdfSyncSettings;
	private currentlyLoadingState: Set<string> = new Set();
	// Store the leaf object reference and file path
	private activePdfInfo: { leaf: WorkspaceLeaf, pdfPath: string, lastSavedPage: number | null } | null = null;
	private saveIntervalId: number | null = null;
	private readonly SAVE_INTERVAL_MS = 7000; // Check state every 7 seconds
	private lastSavedStateTime: number = 0; // Track time of last actual save

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new PdfSyncSettingTab(this.app, this));

		// --- Add Manual Save Command ---
		this.addCommand({
			id: 'pdf-sync-save-current-state',
			name: 'Save current PDF view state now',
			checkCallback: (checking: boolean) => {
				const activeLeaf = this.app.workspace.activeLeaf;
				if (activeLeaf && isPdfView(activeLeaf.view)) {
					if (checking) {
						return true;
					}
					this.triggerManualSave(activeLeaf.view);
					return true;
				}
				return false;
			},
		});

		// --- Event Listeners ---
		this.registerEvent(
			this.app.workspace.on('active-leaf-change', (leaf: WorkspaceLeaf | null /*, oldLeaf: WorkspaceLeaf | null */) => {
				const previouslyTrackedPdfInfo = this.activePdfInfo;

				// Stop saving interval if navigating AWAY from tracked PDF
				if (previouslyTrackedPdfInfo && leaf !== previouslyTrackedPdfInfo.leaf) {
					this.stopSaveInterval();
					const oldTrackedLeaf = previouslyTrackedPdfInfo.leaf;
					this.activePdfInfo = null; // Clear before saving

					if (oldTrackedLeaf && isPdfView(oldTrackedLeaf.view)) {
						this.saveActivePdfState(oldTrackedLeaf.view, true); // Force save
					}
				}

				// LOAD and Start Saving Interval if navigating TO a PDF
				if (leaf && this.settings.enableStateLoading) { // Check loading setting
					const newView = leaf.view;
					if (isPdfView(newView)) {
						const pdfPath = newView.file.path;

						// Update tracked info and start interval if it's a *new* PDF leaf
						if (!this.activePdfInfo || this.activePdfInfo.leaf !== leaf) {
							this.stopSaveInterval();
							this.activePdfInfo = {
								leaf: leaf,
								pdfPath: pdfPath,
								lastSavedPage: null
							};
							this.lastSavedStateTime = 0;
							this.startSaveInterval(); // Start periodic saving check
						}

						// Trigger loading state
						const pdfViewToLoad = newView;
						if (!this.currentlyLoadingState.has(pdfPath)) {
							this.currentlyLoadingState.add(pdfPath);
							setTimeout(() => this.loadPdfState(pdfViewToLoad), 200);
						}

					} else if (this.activePdfInfo) {
						// Stop interval if navigating to a non-PDF leaf
						this.stopSaveInterval();
						this.activePdfInfo = null;
					}
				} else if (!leaf && this.activePdfInfo) {
					 // No active leaf, stop interval and attempt final save
					 this.stopSaveInterval();
					 const oldTrackedLeaf = this.activePdfInfo.leaf;
					 this.activePdfInfo = null;
					 if (oldTrackedLeaf && isPdfView(oldTrackedLeaf.view)) {
						 this.saveActivePdfState(oldTrackedLeaf.view, true);
					 }
				}
			})
		);

		// Save on quit - Last resort catch-all
		this.registerEvent(
			this.app.workspace.on('quit', () => {
				console.log("PDF Sync [Event]: Obsidian quit triggered. Attempting final saves."); // Keep this log for feedback
				this.stopSaveInterval();
				const savePromises: Promise<void>[] = [];
				this.app.workspace.iterateAllLeaves(leaf => {
					// Use isPdfView type guard before accessing file path
					if (isPdfView(leaf.view)) {
						// --- FIX: Get path *before* the async call ---
						const pdfPath = leaf.view.file.path; // Safe access here due to isPdfView guard
						// console.log(`PDF Sync [Quit]: Saving state for ${pdfPath}`); // Log path safely
						// --- END FIX ---

						savePromises.push(
							this.saveActivePdfState(leaf.view, true).catch(e => {
								// --- FIX: Use the stored pdfPath variable ---
								console.error(`PDF Sync [Quit]: Error saving ${pdfPath}`, e);
								// --- END FIX ---
							})
						);
					}
				});
				// console.log(`PDF Sync [Event]: Quit save attempts initiated for ${savePromises.length} PDF views.`); // Keep this log
			})
		);

		// Initial load check
		this.app.workspace.onLayoutReady(() => {
			if (!this.settings.enableStateLoading) return;
			this.app.workspace.iterateAllLeaves((leaf) => {
				const currentView = leaf.view;
				if (isPdfView(currentView)) {
					const pdfPath = currentView.file.path;
					const pdfViewToLoad = currentView;
					if (!this.currentlyLoadingState.has(pdfPath)) {
						this.currentlyLoadingState.add(pdfPath);
						setTimeout(() => this.loadPdfState(pdfViewToLoad), 200);
					}
					// Start interval if this is the initially active leaf
					if (this.app.workspace.activeLeaf === leaf && !this.saveIntervalId) {
						 this.activePdfInfo = {
							leaf: leaf,
							pdfPath: pdfPath,
							lastSavedPage: null
						};
						this.startSaveInterval();
					}
				}
			});
		});
	}

	onunload() {
		this.stopSaveInterval(); // Ensure interval is cleared
	}

	// --- Interval Management ---
	startSaveInterval() {
		this.stopSaveInterval(); // Clear existing interval first
		if (!this.settings.enableStateSaving || !this.activePdfInfo) {
			return;
		}

		const trackedLeaf = this.activePdfInfo.leaf; // Track by leaf reference

		this.saveIntervalId = window.setInterval(() => {
			const currentActiveLeaf = this.app.workspace.activeLeaf;
			// Check if the currently tracked leaf is still active and a PDF view
			if (this.activePdfInfo && currentActiveLeaf === trackedLeaf && isPdfView(currentActiveLeaf.view)) {
				this.saveActivePdfState(currentActiveLeaf.view); // Check and save if needed
			} else {
				// If active leaf changed, or tracked leaf is no longer PDF, stop.
				this.stopSaveInterval();
				this.activePdfInfo = null; // Clear tracker
			}
		}, this.SAVE_INTERVAL_MS);
	}

	stopSaveInterval() {
		if (this.saveIntervalId !== null) {
			window.clearInterval(this.saveIntervalId);
			this.saveIntervalId = null;
		}
	}

	// --- Save State Logic (called by interval and manually) ---
	async saveActivePdfState(pdfView: PdfView, forceSave: boolean = false) {
		if (!this.settings.enableStateSaving || !pdfView.file) {
			return;
		}
		const pdfPath = pdfView.file.path;

		if (this.currentlyLoadingState.has(pdfPath)) {
			 return; // Still loading, don't save yet
		}

		try {
			const fullState = pdfView.getState();
			const currentPage = fullState?.page;

			if (currentPage !== undefined && typeof currentPage === 'number' && currentPage >= 0) {
				const lastKnownSavedPage = (this.activePdfInfo?.pdfPath === pdfPath)
					? this.activePdfInfo.lastSavedPage
					: null;

				if (forceSave || currentPage !== lastKnownSavedPage) {
					const now = Date.now();
					// Optional: Throttle saves unless forced
					if (!forceSave && now - this.lastSavedStateTime < this.SAVE_INTERVAL_MS / 2) {
						return; // Too soon since last save
					}

					await this.savePdfStateDirect(pdfPath, currentPage); // Save the state

					// Update tracker
					if (this.activePdfInfo && this.activePdfInfo.pdfPath === pdfPath) {
						this.activePdfInfo.lastSavedPage = currentPage;
					}
					this.lastSavedStateTime = now;
				}
			}
		} catch (error) {
			console.error(`PDF Sync [State Save]: Error saving ${pdfView.file?.path ?? 'unknown file'}:`, error);
            // Optionally show a Notice for critical save errors
            // new Notice("PDF Sync: Error auto-saving state.");
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	// --- Manual Save Handler ---
	async triggerManualSave(pdfView: PdfView) {
		if (!this.settings.enableStateSaving) {
			new Notice("PDF Sync: Saving disabled.");
			return;
		}
		const pdfPath = pdfView.file.path;
		try {
			const fullState = pdfView.getState();
			const currentPage = fullState?.page;
			if (currentPage !== undefined && typeof currentPage === 'number' && currentPage >= 0) {
				await this.savePdfStateDirect(pdfPath, currentPage); // Save directly

				// Update tracker
				if (this.activePdfInfo && this.activePdfInfo.pdfPath === pdfPath) {
					this.activePdfInfo.lastSavedPage = currentPage;
				}
				this.lastSavedStateTime = Date.now();
				new Notice(`PDF Sync: Saved page ${currentPage + 1}`);
			} else {
				new Notice("PDF Sync: Failed to get current page number.");
			}
		} catch (error) {
			console.error(`PDF Sync [Command]: Error:`, error);
			new Notice("PDF Sync: Error during manual save.");
		}
	}

	// --- State Loading ---
	async loadPdfState(pdfView: PdfView) {
		if (!this.settings.enableStateLoading || !pdfView.file) {
			if (pdfView.file) this.currentlyLoadingState.delete(pdfView.file.path);
			return;
		}

		const pdfFilePath = pdfView.file.path;
		const associatedNotePath = this.getAssociatedNotePath(pdfFilePath);
		if (!associatedNotePath) {
			this.currentlyLoadingState.delete(pdfFilePath);
			return;
		}

		const noteFile = this.app.vault.getAbstractFileByPath(associatedNotePath);
		if (!(noteFile instanceof TFile)) {
			this.currentlyLoadingState.delete(pdfFilePath);
			return; // No associated note found is not an error state
		}

		try {
			const cache = this.app.metadataCache.getFileCache(noteFile);
			const frontmatter = cache?.frontmatter;
			if (!frontmatter) {
				this.currentlyLoadingState.delete(pdfFilePath);
				return; // No frontmatter is not an error
			}

			const fmKey = this.settings.frontmatterKey;
			const rawState = frontmatter[fmKey];

			let pageToLoad: number | undefined = undefined;
			if (typeof rawState === 'object' && rawState !== null && typeof rawState.page === 'number') {
				pageToLoad = rawState.page;
			} else if (typeof rawState === 'number') {
				pageToLoad = rawState; // Handle legacy number format
			}

			if (pageToLoad !== undefined && pageToLoad >= 0) {
				const currentState = pdfView.getState();
				const currentEphemeralState = pdfView.getEphemeralState();
				const currentPageInView = currentState?.page;

				if (currentPageInView !== pageToLoad) {
					const newState = { ...currentState, page: pageToLoad };
					try {
						await pdfView.setState(newState, { eState: currentEphemeralState });
						// Update tracker *after* successful load/setState
						if (this.activePdfInfo && this.activePdfInfo.pdfPath === pdfFilePath) {
							this.activePdfInfo.lastSavedPage = pageToLoad;
						}
						this.lastSavedStateTime = Date.now(); // Reset timer after load
						new Notice(`PDF Sync: Jumped to page ${pageToLoad + 1}`, 1500);
					} catch(e) {
						console.error(`PDF Sync [Load]: setState ERROR:`, e);
						new Notice(`PDF Sync: Error setting PDF page state.`);
					}
				} else {
					// Update tracker even if page didn't change
					if (this.activePdfInfo && this.activePdfInfo.pdfPath === pdfFilePath) {
						this.activePdfInfo.lastSavedPage = pageToLoad;
					}
				    this.lastSavedStateTime = Date.now();
				}
			}
		} catch (error) {
			console.error(`PDF Sync [Load]: Error processing state from ${associatedNotePath}:`, error);
            new Notice(`PDF Sync: Error loading PDF state.`);
		} finally {
			// Clear loading flag after a delay
			setTimeout(() => this.currentlyLoadingState.delete(pdfFilePath), 500);
		}
	}

	// --- State Saving Direct ---
	async savePdfStateDirect(pdfFilePath: string, pageNumber: number) {
		const associatedNotePath = this.getAssociatedNotePath(pdfFilePath);
		if (!associatedNotePath) {
			console.error(`PDF Sync [Save Direct]: Cannot get associated note path for ${pdfFilePath}.`);
			return;
		};

		let noteFile = this.app.vault.getAbstractFileByPath(associatedNotePath);

		// --- Note Creation ---
		if (!(noteFile instanceof TFile)) {
			if (this.settings.createAssociatedNote) {
				try {
					const parentDir = getBasePath(associatedNotePath);
					if (parentDir && parentDir !== '/' && !this.app.vault.getAbstractFileByPath(parentDir)) {
						await this.app.vault.createFolder(parentDir);
					}
					noteFile = await this.app.vault.create(associatedNotePath, '---\n---\n\n');
				} catch (error) {
					console.error(`PDF Sync [Save Direct]: Failed to create note ${associatedNotePath}:`, error);
					new Notice(`PDF Sync: Error creating note ${associatedNotePath}`);
					return;
				}
			} else {
				return; // Note doesn't exist, creation disabled.
			}
		}
		// Re-check after potential creation
		if (!(noteFile instanceof TFile)) {
			 console.error(`PDF Sync [Save Direct]: Note file ${associatedNotePath} is not TFile after check/creation.`);
			 return;
		}

		// --- Modify Frontmatter ---
		let fmModified = false; // Track if change occurs
		try {
			await this.app.fileManager.processFrontMatter(noteFile, (fm) => {
				const fmKey = this.settings.frontmatterKey;
				const stateToStore = { page: pageNumber }; // Save as object
				const existingStateRaw = fm[fmKey];
				let existingPage: number | undefined;

				if (typeof existingStateRaw === 'object' && existingStateRaw !== null && typeof existingStateRaw.page === 'number') {
					existingPage = existingStateRaw.page;
				} else if (typeof existingStateRaw === 'number') {
					existingPage = existingStateRaw;
				}

				// Condition to modify: page differs OR key missing OR format is wrong
				if ( existingPage !== pageNumber || !(fmKey in fm) || typeof existingStateRaw !== 'object' ) {
					fm[fmKey] = stateToStore;
					fmModified = true;
				}
			});

            // Optional: Log success only if modified to reduce noise further
            // if (fmModified) {
            //    console.log(`PDF Sync [Save Direct]: Frontmatter updated for ${associatedNotePath}`);
            // }

		} catch (error) {
			console.error(`PDF Sync [Save Direct]: Error processing frontmatter for ${associatedNotePath}:`, error);
			new Notice(`PDF Sync: Error saving state to note ${associatedNotePath}`);
		}
	}

	// --- Associated Note Path Calculation ---
	getAssociatedNotePath(pdfFilePath: string): string | null {
		if (!pdfFilePath || !this.settings.associatedNotePathTemplate) {
			return null;
		}
		try {
			const pdfFile = this.app.vault.getAbstractFileByPath(pdfFilePath);
			if (!(pdfFile instanceof TFile)) {
				// console.warn(`PDF Sync: No TFile ${pdfFilePath}`); // Keep warn optional
				return null;
			};

			const template = this.settings.associatedNotePathTemplate;
			const pdfFilename = pdfFile.name;
			const pdfBasename = pdfFile.basename;
			const pdfFolderPath = pdfFile.parent?.path === '/' ? '' : pdfFile.parent?.path ?? '';
			const pdfParentFolderName = getParentFolderName(pdfFile.path);

			let filledPath = template
				.replace(/\{\{pdf_filename\}\}/g, pdfFilename)
				.replace(/\{\{pdf_basename\}\}/g, pdfBasename)
				.replace(/\{\{pdf_folder_path\}\}/g, pdfFolderPath)
				.replace(/\{\{pdf_parent_folder_name\}\}/g, pdfParentFolderName);

			// Clean up path separators and validate
			filledPath = filledPath.replace(/\/+/g, '/');
			if (filledPath.startsWith('/') && filledPath.length > 1) {
				filledPath = filledPath.substring(1);
			}
			if (!filledPath || !filledPath.toLowerCase().endsWith('.md') || filledPath === '.md') {
				console.error(`PDF Sync: Invalid path "${filledPath}" generated from template "${template}" for PDF ${pdfFilePath}.`);
				new Notice("PDF Sync: Invalid Path Template configuration.", 5000);
				return null;
			}
			return normalizePath(filledPath);
		} catch (error) {
			console.error(`PDF Sync: Error processing path template for ${pdfFilePath}:`, error);
			new Notice("PDF Sync: Error processing path template.", 5000);
			return null;
		}
	}

} // End of Plugin Class
