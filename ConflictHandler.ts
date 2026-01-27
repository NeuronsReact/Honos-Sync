import { App, TFile, Notice } from 'obsidian';
import { NetworkClient } from './NetworkClient';
import { ConflictInfo } from './types';

export class ConflictHandler {
    constructor(
        private app: App,
        private networkClient: NetworkClient,
        private onMergeSuccess: (file: TFile) => Promise<void>
    ) { }

    /**
     * Handle file conflict
     */
    async handleConflict(file: TFile, conflictData: any) {
        const conflict: ConflictInfo = conflictData.conflict;

        if (!conflict) {
            new Notice(`⚠️ Conflict detected in "${file.path}", but no conflict info provided.`);
            return;
        }

        new Notice(`⚠️ Conflict detected in "${file.path}". Attempting auto-merge...`);

        try {
            // 1. Download server's latest version
            const serverResponse = await this.networkClient.downloadFile(file.path, conflict.currentRevision);
            const serverContent = serverResponse.content || '';

            // 2. Download ancestor version (if exists)
            let ancestorContent = null;
            if (conflict.yourParentRevision > 0) {
                const ancestorResponse = await this.networkClient.downloadFile(file.path, conflict.yourParentRevision);
                ancestorContent = ancestorResponse.content || '';
            }

            // 3. Read local content
            const localContent = await this.app.vault.read(file);

            // 4. Attempt auto-merge if we have an ancestor
            if (ancestorContent !== null) {
                const mergeResult = await this.networkClient.attemptAutoMerge({
                    filePath: file.path,
                    ourContent: localContent,
                    ancestorRevision: conflict.yourParentRevision,
                    theirRevision: conflict.currentRevision,
                });

                if (mergeResult.success && !mergeResult.hasConflict && mergeResult.mergedContent) {
                    // 5a. Auto-merge successful
                    new Notice(`✅ Auto-merged "${file.path}"`);

                    // Write merged content
                    await this.app.vault.modify(file, mergeResult.mergedContent);

                    // Trigger re-upload (which will update parentRevision)
                    await this.onMergeSuccess(file);
                    return;
                }
            }

            // 5b. Auto-merge failed or needed manual resolution
            await this.handleManualConflict(file, localContent, serverContent);

        } catch (error) {
            console.error('Error handling conflict:', error);
            new Notice(`❌ Error handling conflict for "${file.path}"`);
        }
    }

    /**
     * Manual conflict resolution
     */
    private async handleManualConflict(
        file: TFile,
        localContent: string,
        serverContent: string
    ) {
        new Notice(`❌ Cannot auto-merge "${file.path}". Manual resolution required.`);

        // Create conflict backup file
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const conflictFileName = `${file.path}.conflict-${timestamp}.md`;

        // Handle path if file is in folder
        // The simple concatenation might fail if file.path has extension
        // e.g. folder/note.md -> folder/note.md.conflict-...md
        let backupPath = conflictFileName;
        // Ideally: note.conflict.md but let's stick to prompt suggestion or safe unique name

        try {
            await this.app.vault.create(backupPath, serverContent);
        } catch (e) {
            // Fallback for filename issues
            backupPath = `conflict-${timestamp}-${file.name}`;
            await this.app.vault.create(backupPath, serverContent);
        }

        // Insert conflict markers
        const markedContent = `
<<<<<<< LOCAL (Your Version)
${localContent}
=======
${serverContent}
>>>>>>> SERVER (Remote Version)

<!-- Conflict detected. Please resolve manually and re-sync. -->
<!-- A backup of the server version has been saved to: ${backupPath} -->
`.trim();

        await this.app.vault.modify(file, markedContent);

        new Notice(`Conflict backup saved: ${backupPath}`, 5000);
    }
}
