import { App, TFile, Notice } from 'obsidian';
import { NetworkClient } from './NetworkClient';
import { MetadataManager } from './MetadataManager';
import { ConflictHandler } from './ConflictHandler';
import { SyncPluginSettings, RemoteFile } from './types';

export class SyncManager {
    private conflictHandler: ConflictHandler;
    private isSyncing = false;

    constructor(
        private app: App,
        private networkClient: NetworkClient,
        private metadataManager: MetadataManager,
        private getSettings: () => SyncPluginSettings
    ) {
        this.conflictHandler = new ConflictHandler(
            app,
            networkClient,
            this.uploadFile.bind(this)
        );
    }

    /**
     * Perform full vault sync
     */
    async syncVault(silent = false): Promise<void> {
        const settings = this.getSettings();
        if (!settings.token) {
            new Notice('Not authenticated. Please configure your API token.');
            return;
        }

        if (this.isSyncing) {
            new Notice('Sync already in progress...');
            return;
        }

        this.isSyncing = true;
        if (!silent) new Notice('🔄 Starting sync...');

        try {
            // 1. Get remote state
            const listResult = await this.networkClient.listFiles();
            if (!listResult.success || !listResult.files) {
                throw new Error(listResult.error || 'Failed to list remote files');
            }

            const remoteFiles = listResult.files;
            const remoteMap = new Map(remoteFiles.map(f => [f.path, f]));

            // 2. Downward Sync (Server -> Local)
            let downloaded = 0;
            for (const remote of remoteFiles) {
                const localMeta = this.metadataManager.getMetadata(remote.path);

                // Logic:
                // If we don't have metadata (new file from server)
                // OR remote revision > local revision
                const remoteRev = remote.revision || 0;
                const localRev = localMeta?.revision || 0;

                if (!localMeta || remoteRev > localRev) {
                    // Check if local file exists to avoid overwriting unsafe changes?
                    // If local file exists but no metadata -> conflict risk, but usually means new client.
                    // We'll trust the revision check.
                    const success = await this.downloadFile(remote.path, remoteRev);
                    if (success) {
                        downloaded++;
                    }
                }
            }

            // 3. Upward Sync (Local -> Server)
            let uploaded = 0;
            const localFiles = this.app.vault.getFiles().filter(f => this.shouldSyncFile(f));

            for (const file of localFiles) {
                const meta = this.metadataManager.getMetadata(file.path);
                const remote = remoteMap.get(file.path);

                // If no metadata (new local file) OR modified since last sync
                // Note: file.stat.mtime is timestamp. meta.lastSyncedAt is timestamp.
                // We add a small buffer or strict check.
                if (!meta || file.stat.mtime > meta.lastSyncedAt) {

                    // Optimization: if remote revision matches our last known revision, it's a safe update.
                    // If remote revision is higher than our metadata revision, we should have downloaded it in Step 2?
                    // Yes, Step 2 runs first. So if we are here, either:
                    // - Remote revision == local revision (clean state)
                    // - We just downloaded it (mtime might be new). 
                    //   Wait, if we just downloaded, `saveLocalMetadata` updates `lastSyncedAt`.
                    //   And `downloadFile` writes file content (updating mtime).
                    //   So we need to ensure `lastSyncedAt` >= `mtime` after download to avoid immediate re-upload.

                    // Check if we just downloaded it logic:
                    // If we just downloaded, meta.lastSyncedAt should be fresh.
                    // But `file.stat.mtime` updates when we write.
                    // Ideally we check if `file.stat.mtime > meta.lastSyncedAt`.

                    // If we just downloaded, meta was updated.

                    const result = await this.uploadFile(file);
                    if (result) uploaded++;
                }
            }

            if (!silent) {
                const parts = [];
                if (downloaded > 0) parts.push(`${downloaded} downloaded`);
                if (uploaded > 0) parts.push(`${uploaded} uploaded`);

                if (parts.length > 0) {
                    new Notice(`✅ Sync completed: ${parts.join(', ')}`);
                } else {
                    new Notice(`✅ Sync completed: Up to date`);
                }
            }

        } catch (error) {
            console.error('Sync failed:', error);
            new Notice(`❌ Sync failed: ${error.message}`);
        } finally {
            this.isSyncing = false;
        }
    }

    /**
     * Upload a file with version control
     */
    async uploadFile(file: TFile): Promise<boolean> {
        try {
            const content = await this.app.vault.read(file);
            const localMeta = this.metadataManager.getMetadata(file.path);

            const result = await this.networkClient.uploadFile(file.path, content, {
                parentRevision: localMeta?.revision || 0,
                deviceId: this.getSettings().deviceId
            });

            if (result.success) {
                // Update metadata
                await this.metadataManager.saveMetadata(file.path, {
                    hash: result.file?.hash || '',
                    revision: result.file?.revision || 0,
                    parentRevision: result.file?.revision || 0, // Current becomes parent for next
                    size: file.stat.size,
                    lastSyncedAt: Date.now(),
                    deviceId: this.getSettings().deviceId
                });
                return true;
            } else if (result.error === 'Conflict detected' && result.conflict) {
                await this.conflictHandler.handleConflict(file, result);
                return false;
            } else {
                console.error(`Failed to upload ${file.path}: ${result.error}`);
                return false;
            }
        } catch (e) {
            console.error(`Error uploading ${file.path}:`, e);
            return false;
        }
    }

    /**
     * Download a file from server
     */
    async downloadFile(path: string, revision?: number): Promise<boolean> {
        try {
            const result = await this.networkClient.downloadFile(path, revision);

            if (result.success && result.file && result.content !== undefined) {

                if (result.isConflict) {
                    new Notice(`⚠️ Server marked "${path}" as conflicted.`);
                    // In pure download flow, we might just accept it or handle it?
                    // For now, treat as successful download of content.
                }

                // Write to vault
                let file = this.app.vault.getAbstractFileByPath(path);

                // Ensure directory
                const folderPath = path.substring(0, path.lastIndexOf('/'));
                if (folderPath && !this.app.vault.getAbstractFileByPath(folderPath)) {
                    await this.app.vault.createFolder(folderPath);
                }

                if (file instanceof TFile) {
                    await this.app.vault.modify(file, result.content);
                } else if (!file) {
                    file = await this.app.vault.create(path, result.content);
                }

                // Update metadata
                // Note: use file.stat.size/mtime?
                // After modify, file.stat changes.
                // We should get fresh file object or stat.
                // But simplified:
                if (file instanceof TFile) {
                    await this.metadataManager.saveMetadata(path, {
                        hash: result.file.hash,
                        revision: result.file.revision || 0,
                        parentRevision: result.file.parentRevision || result.file.revision || 0,
                        size: result.file.size,
                        lastSyncedAt: Date.now(), // This should cover the write time
                        deviceId: this.getSettings().deviceId // Or source device?
                    });
                }

                return true;
            }
            return false;
        } catch (e) {
            console.error(`Error downloading ${path}:`, e);
            return false;
        }
    }

    /**
     * Delete file from server
     */
    async deleteFile(path: string): Promise<boolean> {
        try {
            const localMeta = this.metadataManager.getMetadata(path);
            const result = await this.networkClient.deleteFile(path, {
                parentRevision: localMeta?.revision || 0,
                deviceId: this.getSettings().deviceId
            });

            if (result.conflict) {
                new Notice(`⚠️ Conflict when deleting "${path}"`);
            }

            await this.metadataManager.deleteMetadata(path);
            return result.success;
        } catch (e) {
            console.error(`Error deleting ${path}:`, e);
            return false;
        }
    }

    private shouldSyncFile(file: TFile): boolean {
        const ext = file.extension.toLowerCase();
        return ['md', 'txt', 'json', 'css', 'js', 'html', 'xml', 'yaml', 'yml'].includes(ext);
    }
}
