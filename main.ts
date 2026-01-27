import { Plugin, Notice, TFile } from 'obsidian';
import { SyncPluginSettingTab } from './SettingsTab';
import { NetworkClient } from './NetworkClient';
import { MetadataManager } from './MetadataManager';
import { SyncManager } from './SyncManager';
import { SyncPluginSettings, DEFAULT_SETTINGS, RemoteFile, SERVER_URL } from './types';

/**
 * Honos Sync Plugin for Obsidian
 * 
 * Syncs your Obsidian vault with Honos-Core backend server.
 */
export default class SyncPlugin extends Plugin {
    settings: SyncPluginSettings;
    networkClient: NetworkClient;
    metadataManager: MetadataManager;
    syncManager: SyncManager;

    private syncIntervalId: number | null = null;
    private statusBarItem: HTMLElement;

    async onload() {
        console.log('Loading Honos Sync Plugin');

        // Load settings
        await this.loadSettings();

        // Ensure device ID exists
        if (!this.settings.deviceId) {
            this.settings.deviceId = `device-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
            await this.saveSettings();
        }

        // Initialize components
        this.metadataManager = new MetadataManager(this);
        await this.metadataManager.load();

        this.networkClient = new NetworkClient(
            SERVER_URL,
            this.settings.token,
            this.settings.deviceName
        );
        this.networkClient.setUseLegacySync(this.settings.useLegacySync);

        this.syncManager = new SyncManager(
            this.app,
            this.networkClient,
            this.metadataManager,
            () => this.settings
        );

        // Add settings tab
        this.addSettingTab(new SyncPluginSettingTab(this.app, this));

        // Add ribbon icon for quick sync
        this.addRibbonIcon('sync', 'Sync with Honos', async () => {
            await this.performSync();
        });

        // Add commands
        this.addCommand({
            id: 'sync-vault',
            name: 'Sync vault now',
            callback: async () => {
                await this.performSync();
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

        // Monitor file changes
        this.registerEvent(
            this.app.vault.on('modify', async (file) => {
                if (this.settings.token && file instanceof TFile) {
                    // Start debounced sync or just log for now?
                    // For immediate consistency, we could trigger upload.
                    // But usually better to let auto-sync or manual sync handle it to avoid spam.
                    // However, for single file edit, we might want to push it.
                    // Let's stick to user request: "Modify file upload logic" (in SyncManager).
                    // We won't auto-upload heavily here unless autoSync is better implemented.
                    // But if we want to ensure revision control is granular,
                    // we might want to upload on save.
                    // For now, I'll log and let manual/interval sync handle it, or maybe trigger uploadFile?
                    // Given the complexity of conflicts, safer to let syncManager handle batch sync or interval.
                    // But `SyncManager.uploadFile` handles conflicts.
                }
            })
        );

        // Handle Rename
        this.registerEvent(
            this.app.vault.on('rename', async (file, oldPath) => {
                if (this.settings.token && file instanceof TFile) {
                    console.log(`File renamed: ${oldPath} -> ${file.path}`);

                    // 1. Delete old path on server
                    await this.syncManager.deleteFile(oldPath);

                    // 2. Upload new path
                    await this.syncManager.uploadFile(file);

                    // 3. Update local metadata
                    await this.metadataManager.renameMetadata(oldPath, file.path);
                }
            })
        );

        this.registerEvent(
            this.app.vault.on('delete', async (file) => {
                if (this.settings.token && file instanceof TFile) {
                    console.log(`File deleted: ${file.path}`);
                    await this.syncManager.deleteFile(file.path);
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
            if (this.settings.token) {
                console.log('Auto-sync triggered');
                this.updateStatusBar('Syncing', 'syncing');
                await this.syncManager.syncVault(true); // Silent sync
                this.updateStatusBar('Idle', 'idle');
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
     * Perform a full vault sync
     */
    async performSync(): Promise<void> {
        this.updateStatusBar('Syncing...', 'syncing');
        await this.syncManager.syncVault(false);
        this.updateStatusBar('Idle', 'idle');
    }

    /**
     * Update the status bar text and icon
     */
    updateStatusBar(text: string, state: 'idle' | 'syncing' | 'error' = 'idle') {
        this.statusBarItem.empty();

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
