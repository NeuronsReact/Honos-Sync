import { Plugin, Notice, TFile, debounce } from 'obsidian';
import { SyncPluginSettingTab } from './SettingsTab';
import { NetworkClient } from './NetworkClient';
import { MetadataManager } from './MetadataManager';
import { WebSocketClient } from './WebSocketClient';
import { calculateHash, splitIntoChunks } from './utils';
import {
    SyncPluginSettings,
    DEFAULT_SETTINGS,
    SERVER_URL,
    RemoteFile
} from './types';

import { diff_match_patch } from 'diff-match-patch';

export default class SyncPlugin extends Plugin {
    settings: SyncPluginSettings;
    networkClient: NetworkClient;
    metadataManager: MetadataManager;
    wsClient: WebSocketClient | null = null;
    private syncIntervalId: number | null = null;
    private isSyncing: boolean = false;
    private wsConnected: boolean = false;
    private statusBarItem: HTMLElement;

    // Debounced sync for file changes
    private debouncedSync = debounce(() => {
        console.log('Debounced sync triggered');
        this.performSync(true);
    }, 5000, true);

    async onload() {
        console.log('Loading Honos Sync Plugin (V2 - Enforced + WebSocket)');

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

        this.addCommand({
            id: 'reset-sync-lock',
            name: 'Force Reset Sync Lock',
            callback: () => {
                this.isSyncing = false;
                this.updateStatusBar('Idle', 'idle');
                new Notice('Sync lock reset. You can try syncing again.');
            }
        });

        // Initialize status bar
        this.statusBarItem = this.addStatusBarItem();
        this.updateStatusBar('Idle', 'idle');

        // Always start auto-sync if token exists
        if (this.settings.token) {
            this.startAutoSync();
        }


        // Initialize WebSocket for real-time sync
        if (this.settings.token) {
            this.wsClient = new WebSocketClient(this.settings.token);
            this.wsClient.onStatusChange((connected) => {
                this.wsConnected = connected;
                this.updateStatusBar(connected ? 'Connected' : 'Disconnected', connected ? 'idle' : 'error');
            });
            this.wsClient.onFileChange(async (event) => {
                console.log('[SYNC] File change notification:', event);
                // Auto-download the changed file
                if (event.type === 'upload' || event.type === 'update') {
                    new Notice('🔄 Syncing...');
                    await this.performSync(true);
                    new Notice('✅ Sync complete');
                }
            });
            this.wsClient.connect();
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
        this.wsClient?.disconnect();
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
        console.log('[SYNC] performSync called, silent:', silent);

        if (!this.settings.token) {
            console.log('[SYNC] No token, aborting');
            if (!silent) new Notice('Please configure API token.');
            return;
        }

        if (this.isSyncing) {
            console.log('[SYNC] Already syncing, skipping');
            if (!silent) new Notice('Sync already in progress...');
            return;
        }

        console.log('[SYNC] Starting sync process');
        this.isSyncing = true;
        this.updateStatusBar('Syncing...', 'syncing');
        if (!silent) new Notice(`🚀 Starting Sync to ${SERVER_URL}...`, 2000);

        try {
            // 1. Get remote state
            console.log('[SYNC] Step 1: Calling networkClient.listFiles()...');
            const listRes = await this.networkClient.listFiles();
            console.log('[SYNC] Step 1 complete. Success:', listRes.success);

            if (!listRes.success) throw new Error(`List files failed: ${listRes.error}`);

            const remoteFiles = listRes.files || [];
            const remoteMap = new Map(remoteFiles.map(f => [f.path, f]));
            console.log(`[SYNC] Remote has ${remoteFiles.length} files`);

            // 2. Get local state
            console.log('[SYNC] Step 2: Getting local files...');
            const localFiles = this.app.vault.getFiles();
            const localMap = new Map(localFiles.map(f => [f.path, f]));

            // Track files processed in this sync cycle to prevent false deletion detection
            const processedPaths = new Set<string>();

            console.log(`[SYNC] Local has ${localFiles.length} files`);

            let processedCount = 0;

            // 3. Process Downloads (Remote is newer)
            console.log('[SYNC] Step 3: Processing downloads...');
            for (const remote of remoteFiles) {
                const localMeta = this.metadataManager.getMetadata(remote.path);
                const localFile = localMap.get(remote.path);

                // If remote revision > local known revision
                if (!localMeta || remote.revision > localMeta.revision) {
                    console.log(`[SYNC] Downloading: ${remote.path}`);
                    await this.processDownload(remote, localFile);
                    processedPaths.add(remote.path);
                    processedCount++;
                }
            }
            console.log(`[SYNC] Downloads complete. Processed ${processedCount}`);

            // 3.5 Process Local Deletes
            console.log('[SYNC] Step 3.5: Processing local deletes...');
            const allMetaPaths = Object.keys(this.metadataManager.getAllMetadata());
            for (const path of allMetaPaths) {
                // CRITICAL FIX: If we just downloaded/processed this file, DO NOT treat it as a local deletion
                // even if it's missing from the initial 'localMap' snapshot.
                if (processedPaths.has(path)) continue;

                if (!localMap.has(path)) {
                    const meta = this.metadataManager.getMetadata(path);
                    // If meta.hash is empty, it's already marked deleted/tombstone
                    if (meta && meta.hash !== '') {
                        const remote = remoteMap.get(path);
                        // If remote is newer, we should have processed it in downloads (or will do)
                        if (remote && remote.revision > meta.revision) {
                            continue;
                        }

                        await this.processLocalDelete(path, meta.revision);
                        processedCount++;
                    }
                }
            }

            // 4. Process Uploads (Local changes)
            console.log('[SYNC] Step 4: Processing uploads...');
            for (const file of localFiles) {
                try {
                    console.log(`[SYNC] Checking file: ${file.path}`);

                    console.log(`[SYNC]   Reading file content...`);
                    const content = await this.app.vault.read(file);
                    console.log(`[SYNC]   Content read. Size: ${content.length}`);

                    console.log(`[SYNC]   Calculating hash...`);
                    const currentHash = await calculateHash(content);
                    console.log(`[SYNC]   Hash calculated: ${currentHash.substring(0, 8)}...`);

                    const localMeta = this.metadataManager.getMetadata(file.path);

                    // If Hash changed compared to what we last synced
                    if (!localMeta || localMeta.hash !== currentHash) {
                        const remote = remoteMap.get(file.path);
                        if (remote && localMeta && remote.revision > localMeta.revision) {
                            // Conflict or missed update: skip upload
                            console.log(`[SYNC]   Skipping (remote is newer)`);
                            continue;
                        }

                        // if (!silent) new Notice(`Uploading ${file.path}...`, 1000);
                        console.log(`[SYNC]   Uploading...`);
                        await this.processUpload(file, content, currentHash, localMeta?.revision || 0);
                        processedCount++;
                    } else {
                        console.log(`[SYNC]   No changes`);
                    }
                } catch (fileErr) {
                    console.error(`[SYNC] Error processing file ${file.path}:`, fileErr);
                    // Continue to next file
                }
            }
            console.log(`[SYNC] Uploads complete`);

            console.log('[SYNC] Saving settings...');
            await this.saveSettings();
            console.log('[SYNC] Settings saved');

            if (!silent) {
                new Notice('✅ Sync complete');
            }
            console.log('[SYNC] Sync completed successfully');

        } catch (err: any) {
            console.error('[SYNC] Sync error:', err);
            if (!silent) new Notice(`❌ Sync failed: ${err.message}`);
            this.updateStatusBar('Error', 'error');
        } finally {
            console.log('[SYNC] Finally block: resetting isSyncing flag');
            this.isSyncing = false;
            // console.log('Sync finished, flag reset.'); // Original line, replaced by the above
            if (!this.statusBarItem.getText().includes('Error')) {
                this.updateStatusBar('Idle', 'idle');
            }
            console.log('[SYNC] Sync cleanup complete');
        }
    }

    async processDownload(remote: RemoteFile, localFile: TFile | undefined) {
        // console.log(`Downloading ${remote.path} (Rev: ${remote.revision})`);

        // Handle Remote Deletion
        if (remote.isDeleted) {
            console.log(`[SYNC] Remote file deleted: ${remote.path}`);
            if (localFile) {
                await this.app.vault.delete(localFile);
            }
            // Update metadata to track this deletion revision
            this.metadataManager.updateMetadata(remote.path, {
                path: remote.path,
                hash: '',
                revision: remote.revision,
                parentRevision: remote.revision,
                updatedAt: Date.now()
            });
            return;
        }

        // --- NEW CONFLICT PROTECTION (Inline Merge) ---
        if (localFile) {
            try {
                const content = await this.app.vault.read(localFile);
                const currentHash = await calculateHash(content);
                const meta = this.metadataManager.getMetadata(remote.path);

                // Check for conflict
                if (meta && meta.hash !== currentHash) {
                    console.log(`[SYNC] Conflict detected on ${remote.path}. Merging...`);

                    // 1. Download remote content explicitly
                    const dlRes = await this.networkClient.downloadFile(remote.path, remote.revision);
                    if (!dlRes.success || !dlRes.file) {
                        throw new Error('Failed to download remote content for merge');
                    }
                    const remoteContent = dlRes.file.content;

                    // 2. Compute Diff
                    const dmp = new diff_match_patch();
                    const diffs = dmp.diff_main(content, remoteContent);
                    dmp.diff_cleanupSemantic(diffs);

                    // 3. Construct Conflict Text
                    let mergedContent = '';
                    // Simple reconstruction with markers for diffs
                    // Strategy: If Equal -> push. If Del/Ins -> Conflict block.
                    // But diffs are sequential. DELETE(Local) usually followed by INSERT(Remote).

                    for (let i = 0; i < diffs.length; i++) {
                        const [type, text] = diffs[i];
                        if (type === 0) { // EQUAL
                            mergedContent += text;
                        } else {
                            // Start conflict block
                            mergedContent += `\n<<<<<<< Local\n`;
                            // Accumulate local changes (DELETE from remote perspective means present in Local)
                            // Wait: diff_main(text1, text2). text1=Local, text2=Remote.
                            // DELETE means "In Local, not in Remote". INSERT means "In Remote, not in Local".

                            if (type === -1) { // DELETE (Local only)
                                mergedContent += text;
                                // Check next for INSERT (Remote only)
                                if (i + 1 < diffs.length && diffs[i + 1][0] === 1) {
                                    mergedContent += `\n=======\n`;
                                    mergedContent += diffs[i + 1][1];
                                    i++; // Skip next
                                } else {
                                    mergedContent += `\n=======\n`; // Empty remote
                                }
                            } else if (type === 1) { // INSERT (Remote only)
                                // Means Local had nothing here.
                                // mergedContent += `(empty)\n=======\n${text}`;
                                // Actually usually better to just Output Insert if it's pure addition?
                                // User wants to see conflict.
                                mergedContent += `(missing in local)\n=======\n${text}`;
                            }

                            mergedContent += `\n>>>>>>> Remote\n`;
                        }
                    }

                    // 4. Write merged styling is hard with simple loop.
                    // Better approach: Use dmp.patch_make and maybe manual formatting?
                    // Actually, let's keep it simple: If any diff, just dump both files?
                    // No, user wants smart diff.
                    // Let's use a simpler heuristic: If diff is small/simple, keep it. 
                    // But actually, just dumping the standard git conflict style is safest.

                    // Re-implement simplified loop:
                    mergedContent = '';
                    let i = 0;
                    while (i < diffs.length) {
                        const [type, text] = diffs[i];
                        if (type === 0) {
                            mergedContent += text;
                            i++;
                        } else {
                            mergedContent += `\n<<<<<<< Local\n`;
                            if (type === -1) { // Local content
                                mergedContent += text;
                                i++;
                                if (i < diffs.length && diffs[i][0] === 1) { // Remote content replacement
                                    mergedContent += `\n=======\n${diffs[i][1]}`;
                                    i++;
                                } else {
                                    mergedContent += `\n=======\n`; // Deleted in remote
                                }
                            } else { // INSERT (Remote added, Local didn't have)
                                mergedContent += `\n=======\n${text}`;
                                i++;
                            }
                            mergedContent += `\n>>>>>>> Remote\n`;
                        }
                    }

                    await this.app.vault.modify(localFile, mergedContent);
                    new Notice(`⚠️ Merge Conflict in ${remote.path}. Please resolve markers.`);

                    // Mark metadata as updated to this revision so we don't download again
                    // But we leave the file "dirty" (hash changed), so next upload cycle will upload the merged version (with markers)
                    // unless user fixes it fast.
                    this.metadataManager.updateMetadata(remote.path, {
                        ...meta,
                        revision: remote.revision, // We pretend we are on remote revision now
                        updatedAt: Date.now()
                    });

                    return; // Skip normal download
                }
            } catch (err) {
                console.error('[SYNC] Error merging conflict:', err);
            }
        }
        // ---------------------------------------------------

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

    async processLocalDelete(path: string, parentRevision: number) {
        console.log(`[SYNC] Deleting remote file: ${path}`);
        const res = await this.networkClient.deleteFile(path, parentRevision);
        if (res.success && res.revision) {
            this.metadataManager.updateMetadata(path, {
                path,
                hash: '',
                revision: res.revision,
                parentRevision: res.revision,
                updatedAt: Date.now()
            });
        } else if (res.conflict) {
            // If conflict on delete, it means someone else updated it. 
            // We should probably download the update in next sync.
            // For now, just log it.
            console.log('[SYNC] Conflict on delete, ignoring.');
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
        let indicator = '🔴'; // Default disconnected

        if (this.wsConnected) {
            indicator = '🟢';
        }

        if (state === 'syncing') {
            indicator = '🔄';
        }

        this.statusBarItem.setText(`Honos ${indicator}`);
        this.statusBarItem.setAttr('title', `Honos Sync: ${text}`); // Tooltip shows detail

        if (state === 'error') {
            this.statusBarItem.addClass('mod-error');
        } else {
            this.statusBarItem.removeClass('mod-error');
            // Remove text color modification classes if any
        }
    }
}
