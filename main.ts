import { Plugin, Notice, TFile, debounce } from 'obsidian';
import { SyncPluginSettingTab } from './SettingsTab';
import { NetworkClient } from './NetworkClient';
import { MetadataManager } from './MetadataManager';
import { calculateHash, splitIntoChunks } from './utils';
import {
    SyncPluginSettings,
    DEFAULT_SETTINGS,
    SERVER_URL,
    RemoteFile
} from './types';

export default class SyncPlugin extends Plugin {
    settings: SyncPluginSettings;
    networkClient: NetworkClient;
    metadataManager: MetadataManager;
    private syncIntervalId: number | null = null;
    private isSyncing: boolean = false;
    private statusBarItem: HTMLElement;

    // Debounced sync for file changes
    private debouncedSync = debounce(() => {
        console.log('Debounced sync triggered');
        this.performSync(true);
    }, 5000, true);

    async onload() {
        console.log('Loading Honos Sync Plugin (V2 - Enforced)');

        await this.loadSettings();

        // Enforce default settings
        this.settings.autoSync = true;
        this.settings.syncInterval = 1;

        // Initialize components
        this.networkClient = new NetworkClient(
            SERVER_URL,
            this.settings.token,
            this.settings.deviceName
        );

        this.metadataManager = new MetadataManager(this);
        if (this.settings.filesMetadata) {
            this.metadataManager.setAllMetadata(this.settings.filesMetadata);
        }

        // Add settings tab
        this.addSettingTab(new SyncPluginSettingTab(this.app, this));

        // Add ribbon icon
        this.addRibbonIcon('sync', 'Sync with Honos', async () => {
            await this.performSync();
        });

        // Add commands
        this.addCommand({
            id: 'sync-vault',
            name: 'Sync vault now',
            callback: async () => await this.performSync()
        });

        // Initialize status bar
        this.statusBarItem = this.addStatusBarItem();
        this.updateStatusBar('Idle', 'idle');

        // Always start auto-sync if token exists
        if (this.settings.token) {
            this.startAutoSync();
        }

        // Event Listeners for File Changes
        this.registerEvent(this.app.vault.on('modify', (f) => this.onChange(f)));
        this.registerEvent(this.app.vault.on('create', (f) => this.onChange(f)));
        this.registerEvent(this.app.vault.on('delete', () => this.debouncedSync()));
        this.registerEvent(this.app.vault.on('rename', () => this.debouncedSync()));
    }

    onChange(file: any) {
        if (this.settings.token && file instanceof TFile) {
            this.debouncedSync();
        }
    }

    onunload() {
        this.stopAutoSync();
        this.saveSettings(); // Save metadata on unload
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        // Persist metadata into settings
        this.settings.filesMetadata = this.metadataManager.getAllMetadata();
        await this.saveData(this.settings);
    }

    startAutoSync(): void {
        this.stopAutoSync();
        // Force 1 minute interval
        const intervalMs = 60 * 1000;
        this.syncIntervalId = window.setInterval(async () => {
            if (this.settings.token && !this.isSyncing) {
                console.log('Auto-sync triggered (Timer)');
                await this.performSync(true);
            }
        }, intervalMs);
        console.log('Auto-sync started (1 min interval)');
    }

    stopAutoSync(): void {
        if (this.syncIntervalId !== null) {
            window.clearInterval(this.syncIntervalId);
            this.syncIntervalId = null;
        }
    }

    async performSync(silent: boolean = false): Promise<void> {
        if (!this.settings.token) {
            if (!silent) new Notice('Please configure API token.');
            return;
        }

        if (this.isSyncing) {
            if (!silent) new Notice('Sync already in progress...');
            console.log('Skipping sync: already isSyncing');
            return;
        }

        this.isSyncing = true;
        this.updateStatusBar('Syncing...', 'syncing');
        if (!silent) new Notice('🚀 Starting Sync...', 2000);

        try {
            // 1. Get remote state
            // if (!silent) new Notice('Step 1: Fetching remote files...', 2000);
            const listRes = await this.networkClient.listFiles();
            if (!listRes.success) throw new Error(`List files failed: ${listRes.error}`);

            const remoteFiles = listRes.files || [];
            const remoteMap = new Map(remoteFiles.map(f => [f.path, f]));

            // 2. Get local state
            // if (!silent) new Notice('Step 2: Scanning local files...', 2000);
            const localFiles = this.app.vault.getFiles();
            const localMap = new Map(localFiles.map(f => [f.path, f]));

            let processedCount = 0;

            // 3. Process Downloads (Remote is newer)
            for (const remote of remoteFiles) {
                const localMeta = this.metadataManager.getMetadata(remote.path);
                const localFile = localMap.get(remote.path);

                // If remote revision > local known revision
                if (!localMeta || remote.revision > localMeta.revision) {
                    await this.processDownload(remote, localFile);
                    processedCount++;
                }
            }

            // 4. Process Uploads (Local changes)
            for (const file of localFiles) {
                try {
                    // console.log(`Checking ${file.path}`);
                    const content = await this.app.vault.read(file);
                    const currentHash = await calculateHash(content);
                    const localMeta = this.metadataManager.getMetadata(file.path);

                    // If Hash changed compared to what we last synced
                    if (!localMeta || localMeta.hash !== currentHash) {
                        const remote = remoteMap.get(file.path);
                        if (remote && localMeta && remote.revision > localMeta.revision) {
                            // Conflict or missed update: skip upload
                            continue;
                        }

                        // if (!silent) new Notice(`Uploading ${file.path}...`, 1000);
                        await this.processUpload(file, content, currentHash, localMeta?.revision || 0);
                        processedCount++;
                    }
                } catch (fileErr) {
                    console.error(`Error processing file ${file.path}:`, fileErr);
                    // Continue to next file
                }
            }

            await this.saveSettings();

            if (!silent) {
                if (processedCount > 0) new Notice(`✅ Sync complete. Processed ${processedCount} files.`);
                else new Notice(`✅ Sync complete. No changes necessary.`);
            }

        } catch (err: any) {
            console.error('Sync error:', err);
            if (!silent) new Notice(`❌ Sync failed: ${err.message}`);
            this.updateStatusBar('Error', 'error');
        } finally {
            this.isSyncing = false;
            console.log('Sync finished, flag reset.');
            if (!this.statusBarItem.getText().includes('Error')) {
                this.updateStatusBar('Idle', 'idle');
            }
        }
    }

    async processDownload(remote: RemoteFile, localFile: TFile | undefined) {
        // console.log(`Downloading ${remote.path} (Rev: ${remote.revision})`);

        const res = await this.networkClient.downloadFile(remote.path, remote.revision);
        if (res.success && res.file && res.file.content !== undefined) {
            if (localFile) {
                await this.app.vault.modify(localFile, res.file.content);
            } else {
                await this.ensureFolder(remote.path);
                await this.app.vault.create(remote.path, res.file.content);
            }

            this.metadataManager.updateMetadata(remote.path, {
                path: remote.path,
                hash: remote.hash,
                revision: remote.revision,
                parentRevision: remote.revision,
                updatedAt: Date.now()
            });
        }
    }

    async processUpload(file: TFile, content: string, hash: string, parentRevision: number) {
        // console.log(`Uploading ${file.path} (ParentRev: ${parentRevision})`);

        const chunks = splitIntoChunks(content);
        const res = await this.networkClient.uploadFile(
            file.path,
            chunks,
            hash,
            file.stat.size,
            parentRevision
        );

        if (res.success && res.revision) {
            this.metadataManager.updateMetadata(file.path, {
                path: file.path,
                hash: hash,
                revision: res.revision,
                parentRevision: res.revision,
                updatedAt: Date.now()
            });
        } else if (res.conflict) {
            new Notice(`⚠️ Conflict detected in ${file.path}`);
            const conflictPath = this.getConflictPath(file.path);
            await this.app.vault.adapter.rename(file.path, conflictPath);
            this.metadataManager.deleteMetadata(file.path);
            new Notice(`Moved local changes to ${conflictPath}`);
        }
    }

    async ensureFolder(filePath: string) {
        const folder = filePath.substring(0, filePath.lastIndexOf('/'));
        if (folder && !(await this.app.vault.adapter.exists(folder))) {
            await this.app.vault.createFolder(folder);
        }
    }

    getConflictPath(path: string): string {
        const ext = path.split('.').pop();
        const base = path.substring(0, path.lastIndexOf('.'));
        return `${base}.conflict-${Date.now()}.${ext}`;
    }

    updateStatusBar(text: string, state: 'idle' | 'syncing' | 'error') {
        this.statusBarItem.setText(`Honos: ${text}`);
        if (state === 'error') this.statusBarItem.addClass('status-bar-item mod-error');
        else this.statusBarItem.removeClass('status-bar-item mod-error');
    }
}
