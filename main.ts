import { Plugin, Notice, TFile } from 'obsidian';
import { SyncPluginSettingTab } from './SettingsTab';
import { NetworkClient } from './NetworkClient';
import { SyncPluginSettings, DEFAULT_SETTINGS, RemoteFile, SERVER_URL } from './types';

/**
 * Honos Sync Plugin for Obsidian
 * 
 * Syncs your Obsidian vault with Honos-Core backend server.
 */
export default class SyncPlugin extends Plugin {
    settings: SyncPluginSettings;
    networkClient: NetworkClient;
    private syncIntervalId: number | null = null;
    private isSyncing: boolean = false;
    private statusBarItem: HTMLElement;

    async onload() {
        console.log('Loading Honos Sync Plugin');

        // Load settings
        await this.loadSettings();

        // Initialize network client
        this.networkClient = new NetworkClient(
            SERVER_URL,
            this.settings.token,
            this.settings.deviceName
        );

        // Add settings tab
        this.addSettingTab(new SyncPluginSettingTab(this.app, this));

        // Add ribbon icon for quick sync
        this.addRibbonIcon('sync', 'Sync with Honos', async () => {
            if (!this.settings.token) {
                new Notice('Please configure your API token in settings first');
                return;
            }
            await this.performSync();
        });

        // Add commands
        this.addCommand({
            id: 'sync-vault',
            name: 'Sync vault now',
            callback: async () => {
                if (!this.settings.token) {
                    new Notice('Please configure your API token in settings first');
                    return;
                }
                await this.performSync();
            }
        });

        this.addCommand({
            id: 'open-sync-settings',
            name: 'Open sync settings',
            callback: () => {
                // @ts-ignore - accessing private API
                this.app.setting.open();
                // @ts-ignore - accessing private API
                this.app.setting.openTabById(this.manifest.id);
            }
        });

        this.addCommand({
            id: 'check-sync-status',
            name: 'Check sync status',
            callback: async () => {
                if (!this.settings.token) {
                    new Notice('Please configure your API token first');
                    return;
                }
                await this.showSyncStatus();
            }
        });

        // Start auto-sync if enabled
        if (this.settings.autoSync && this.settings.token) {
            this.startAutoSync();
        }

        // Monitor file changes (for future real-time sync feature)
        this.registerEvent(
            this.app.vault.on('modify', async (file) => {
                if (this.settings.token && file instanceof TFile) {
                    console.log(`File modified: ${file.path}`);
                    // TODO: Implement debounced auto-sync on file change
                }
            })
        );

        this.registerEvent(
            this.app.vault.on('delete', async (file) => {
                if (this.settings.token && file instanceof TFile) {
                    console.log(`File deleted: ${file.path}`);
                    // TODO: Implement sync on file delete
                }
            })
        );

        this.registerEvent(
            this.app.vault.on('rename', async (file, oldPath) => {
                if (this.settings.token && file instanceof TFile) {
                    console.log(`File renamed: ${oldPath} → ${file.path}`);
                    // TODO: Implement sync on file rename
                }
            })
        );

        // Add status bar item
        this.statusBarItem = this.addStatusBarItem();
        this.updateStatusBar('Idle', 'idle');
    }

    onunload() {
        console.log('Unloading Honos Sync Plugin');
        this.stopAutoSync();
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    /**
     * Start auto-sync interval
     */
    startAutoSync(): void {
        this.stopAutoSync(); // Clear existing interval

        const intervalMs = this.settings.syncInterval * 60 * 1000;
        this.syncIntervalId = window.setInterval(async () => {
            if (this.settings.token && !this.isSyncing) {
                console.log('Auto-sync triggered');
                await this.performSync(true); // Silent sync
            }
        }, intervalMs);

        console.log(`Auto-sync started: every ${this.settings.syncInterval} minutes`);
    }

    /**
     * Stop auto-sync interval
     */
    stopAutoSync(): void {
        if (this.syncIntervalId !== null) {
            window.clearInterval(this.syncIntervalId);
            this.syncIntervalId = null;
            console.log('Auto-sync stopped');
        }
    }

    /**
     * Show sync status in a notice
     */
    async showSyncStatus(): Promise<void> {
        const result = await this.networkClient.getSyncStatus();

        if (result.success && result.status) {
            const s = result.status;
            const usedMB = (s.storage.used / 1024 / 1024).toFixed(2);

            new Notice(
                `📊 Honos Sync Status\n\n` +
                `👤 User: ${s.user.email}\n` +
                `📁 Files: ${s.files.count}\n` +
                `💾 Storage: ${usedMB} MB\n` +
                `🔗 Connected: ${s.connected ? 'Yes' : 'No'}`,
                15000
            );
        } else {
            new Notice(`❌ Failed to get status: ${result.error}`);
        }
    }

    /**
     * Perform a full vault sync (bidirectional)
     * @param silent - If true, don't show notices for success
     */
    async performSync(silent: boolean = false): Promise<void> {
        if (!this.settings.token) {
            new Notice('Not authenticated. Please configure your API token.');
            return;
        }

        if (this.isSyncing) {
            new Notice('Sync already in progress...');
            return;
        }

        this.isSyncing = true;
        this.updateStatusBar('Syncing...', 'syncing');

        try {
            if (!silent) {
                new Notice('🔄 Starting bidirectional sync...');
            }

            // Step 1: Get remote files from server
            const remoteFilesResult = await this.networkClient.listFiles();
            if (!remoteFilesResult.success) {
                throw new Error(`Failed to get remote files: ${remoteFilesResult.error}`);
            }

            const remoteFiles = remoteFilesResult.files || [];
            const remoteFilePaths = new Set(remoteFiles.map(f => f.path));

            // Step 2: Get local files
            const localFiles = this.app.vault.getFiles().filter(file => {
                const ext = file.extension.toLowerCase();
                return ['md', 'txt', 'json', 'css', 'js', 'html', 'xml', 'yaml', 'yml'].includes(ext);
            });
            const localFilePaths = new Set(localFiles.map(f => f.path));

            let downloadedCount = 0;
            let uploadedCount = 0;
            let failedCount = 0;

            // Step 3: Download files that exist on server but not locally
            for (const remoteFile of remoteFiles) {
                if (!localFilePaths.has(remoteFile.path)) {
                    console.log(`Downloading new file from server: ${remoteFile.path}`);
                    const success = await this.downloadFile(remoteFile.path);
                    if (success) {
                        downloadedCount++;
                    } else {
                        failedCount++;
                    }
                }
            }

            // Step 4: Upload local files to server
            for (const file of localFiles) {
                try {
                    const content = await this.app.vault.read(file);
                    const result = await this.networkClient.uploadFile(file.path, content);

                    if (result.success) {
                        uploadedCount++;
                    } else {
                        failedCount++;
                        console.error(`Failed to upload ${file.path}: ${result.error}`);

                        // Handle authentication errors
                        if (result.error?.includes('Unauthorized') || result.error?.includes('Invalid')) {
                            new Notice('❌ Authentication failed. Please check your API token.');
                            this.isSyncing = false;
                            this.updateStatusBar('Auth Failed', 'error');
                            return;
                        }
                    }
                } catch (error) {
                    failedCount++;
                    console.error(`Error uploading ${file.path}:`, error);
                }
            }

            // Show summary
            if (!silent || failedCount > 0) {
                const parts = [];
                if (downloadedCount > 0) parts.push(`${downloadedCount} downloaded`);
                if (uploadedCount > 0) parts.push(`${uploadedCount} uploaded`);
                if (failedCount > 0) parts.push(`${failedCount} failed`);

                const summary = parts.join(', ');

                if (failedCount > 0) {
                    new Notice(`⚠️ Sync completed: ${summary}`);
                } else if (downloadedCount === 0 && uploadedCount === 0) {
                    new Notice(`✅ Sync completed: Already up to date`);
                } else {
                    new Notice(`✅ Sync completed: ${summary}`);
                }
            }
        } catch (error) {
            console.error('Sync error:', error);
            new Notice(`❌ Sync failed: ${error.message || 'Please check your connection.'}`);
            this.updateStatusBar('Sync Failed', 'error');
        } finally {
            this.isSyncing = false;
            if (!this.statusBarItem.getText().includes('Failed')) {
                this.updateStatusBar('Synced', 'idle');
                setTimeout(() => this.updateStatusBar('Idle', 'idle'), 3000);
            }
        }
    }

    /**
     * Upload a single file to the server
     */
    async uploadFile(file: TFile): Promise<boolean> {
        if (!this.settings.token) {
            return false;
        }

        try {
            const content = await this.app.vault.read(file);
            const result = await this.networkClient.uploadFile(file.path, content);

            if (!result.success) {
                console.error(`Failed to upload ${file.path}: ${result.error}`);
            }

            return result.success;
        } catch (error) {
            console.error(`Error uploading ${file.path}:`, error);
            return false;
        }
    }

    /**
     * Download a single file from the server
     */
    async downloadFile(filePath: string): Promise<boolean> {
        if (!this.settings.token) {
            return false;
        }

        try {
            const result = await this.networkClient.downloadFile(filePath);

            if (result.success && result.content !== undefined) {
                // Check if file exists
                const existingFile = this.app.vault.getAbstractFileByPath(filePath);

                if (existingFile instanceof TFile) {
                    await this.app.vault.modify(existingFile, result.content);
                } else {
                    // Create parent folders if needed
                    const folder = filePath.substring(0, filePath.lastIndexOf('/'));
                    if (folder) {
                        await this.app.vault.createFolder(folder).catch(() => { });
                    }
                    await this.app.vault.create(filePath, result.content);
                }

                return true;
            }

            return false;
        } catch (error) {
            console.error(`Error downloading ${filePath}:`, error);
            return false;
        }
    }

    /**
     * Delete a file from the server
     */
    async deleteRemoteFile(filePath: string): Promise<boolean> {
        if (!this.settings.token) {
            return false;
        }

        try {
            const result = await this.networkClient.deleteFile(filePath);
            return result.success;
        } catch (error) {
            console.error(`Error deleting ${filePath}:`, error);
            return false;
        }
    }

    /**
     * Get list of remote files
     */
    async getRemoteFiles(): Promise<RemoteFile[] | null> {
        if (!this.settings.token) {
            return null;
        }

        try {
            const result = await this.networkClient.listFiles();
            if (result.success) {
                return result.files || [];
            }
            return null;
        } catch (error) {
            console.error('Error getting remote files:', error);
            return null;
        }
    }

    /**
     * Update the status bar text and icon
     */
    updateStatusBar(text: string, state: 'idle' | 'syncing' | 'error' = 'idle') {
        let icon = 'sync';

        switch (state) {
            case 'syncing':
                icon = 'refresh-cw';
                break;
            case 'error':
                icon = 'alert-triangle';
                break;
            case 'idle':
            default:
                icon = 'check-circle'; // Or cloud
                break;
        }

        // Simple text update for now, can be enhanced with icons if needed
        // Using standard text updates. To add actual icons we need verify standard obsidian icons or use setIcon

        this.statusBarItem.empty();

        // Add minimal styling
        if (state === 'syncing') {
            this.statusBarItem.addClass('sync-plugin-status-syncing');
        } else {
            this.statusBarItem.removeClass('sync-plugin-status-syncing');
        }

        if (state === 'error') {
            this.statusBarItem.addClass('sync-plugin-status-error');
        } else {
            this.statusBarItem.removeClass('sync-plugin-status-error');
        }

        this.statusBarItem.setText(`Honos: ${text}`);
    }
}
