import { Plugin } from 'obsidian';
import { LocalFileMetadata } from './types';

export class MetadataManager {
    private plugin: Plugin;
    private metadata: Record<string, LocalFileMetadata> = {};
    private loaded = false;
    private metadataPath: string;

    constructor(plugin: Plugin) {
        this.plugin = plugin;
        this.metadataPath = `${this.plugin.manifest.dir}/metadata.json`;
    }

    async load() {
        if (this.loaded) return;
        const adapter = this.plugin.app.vault.adapter;

        if (await adapter.exists(this.metadataPath)) {
            const content = await adapter.read(this.metadataPath);
            try {
                this.metadata = JSON.parse(content);
            } catch (e) {
                console.error('Failed to parse metadata', e);
                this.metadata = {};
            }
        }
        this.loaded = true;
    }

    async save() {
        const adapter = this.plugin.app.vault.adapter;
        await adapter.write(this.metadataPath, JSON.stringify(this.metadata));
    }

    getMetadata(path: string): LocalFileMetadata | null {
        return this.metadata[path] || null;
    }

    async saveMetadata(path: string, meta: Partial<LocalFileMetadata>) {
        const current = this.metadata[path] || {
            path,
            hash: '',
            size: 0,
            revision: 0,
            parentRevision: 0,
            lastSyncedAt: 0
        };

        this.metadata[path] = { ...current, ...meta, path }; // Ensure path is set
        await this.save();
    }

    async deleteMetadata(path: string) {
        if (this.metadata[path]) {
            delete this.metadata[path];
            await this.save();
        }
    }

    async renameMetadata(oldPath: string, newPath: string) {
        if (this.metadata[oldPath]) {
            this.metadata[newPath] = { ...this.metadata[oldPath], path: newPath };
            delete this.metadata[oldPath];
            await this.save();
        }
    }
}
