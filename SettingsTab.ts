import { App, PluginSettingTab, Setting, Notice } from 'obsidian';
import SyncPlugin from './main';
import { NetworkClient } from './NetworkClient';

/**
 * SettingsTab - UI for plugin configuration and authentication
 * 
 * Authentication Flow:
 * 1. User creates an API Token via the Honos-Core Web Dashboard
 * 2. User pastes the token into this settings page
 * 3. Plugin verifies the token and stores it
 */
export class SyncPluginSettingTab extends PluginSettingTab {
    plugin: SyncPlugin;
    private verifyInProgress: boolean = false;

    constructor(app: App, plugin: SyncPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        // Header
        containerEl.createEl('h2', { text: 'Honos Sync Settings' });

        // ===== Server Status =====
        const serverStatusContainer = containerEl.createDiv({ cls: 'sync-server-status' });
        this.updateServerStatus(serverStatusContainer);

        // ===== content =====

        // ===== Authentication =====
        containerEl.createEl('h3', { text: '🔐 Authentication' });

        // Authentication status
        const authStatusContainer = containerEl.createDiv({ cls: 'sync-auth-status' });
        this.updateAuthStatus(authStatusContainer);

        // API Token input
        new Setting(containerEl)
            .setName('API Token')
            .setDesc('Paste your API Token from the Honos-Core Web Dashboard. Go to Dashboard → API Tokens → Create New Token')
            .addText(text => {
                text
                    .setPlaceholder('Enter your API token...')
                    .setValue(this.plugin.settings.token)
                    .onChange(async (value) => {
                        this.plugin.settings.token = value;
                        await this.plugin.saveSettings();
                        this.plugin.networkClient.setToken(value);
                    });
                // Make input wider and password-like
                text.inputEl.type = 'password';
                text.inputEl.style.width = '100%';
            });

        // Verify Token Button
        new Setting(containerEl)
            .setName('Verify Token')
            .setDesc('Test your API token to ensure it is valid')
            .addButton(button => button
                .setButtonText('Verify Token')
                .setCta()
                .onClick(async () => {
                    if (this.verifyInProgress) return;

                    const token = this.plugin.settings.token.trim();
                    if (!token) {
                        new Notice('Please enter an API token first');
                        return;
                    }

                    this.verifyInProgress = true;
                    button.setButtonText('Verifying...');
                    button.setDisabled(true);

                    const result = await this.plugin.networkClient.verifyToken();

                    this.verifyInProgress = false;
                    button.setButtonText('Verify Token');
                    button.setDisabled(false);

                    if (result.success && result.user) {
                        new Notice(`✅ Token verified! Logged in as ${result.user.email}`);
                        this.updateAuthStatus(authStatusContainer);
                    } else {
                        new Notice(`❌ Token verification failed: ${result.error}`);
                    }
                }));

        // Clear Token Button
        new Setting(containerEl)
            .setName('Clear Token')
            .setDesc('Remove the stored API token')
            .addButton(button => button
                .setButtonText('Clear Token')
                .setWarning()
                .onClick(async () => {
                    this.plugin.settings.token = '';
                    await this.plugin.saveSettings();
                    this.plugin.networkClient.setToken('');
                    new Notice('API token cleared');
                    this.display(); // Refresh the settings tab
                }));

        // ===== Device Settings =====
        containerEl.createEl('h3', { text: '💻 Device Settings' });

        new Setting(containerEl)
            .setName('Device Name')
            .setDesc('A friendly name for this device (helps identify sync sources)')
            .addText(text => text
                .setPlaceholder('My MacBook')
                .setValue(this.plugin.settings.deviceName)
                .onChange(async (value) => {
                    this.plugin.settings.deviceName = value;
                    await this.plugin.saveSettings();
                    this.plugin.networkClient.setDeviceName(value);
                }));

        // ===== Sync Settings =====
        if (this.plugin.settings.token) {
            containerEl.createEl('h3', { text: '🔄 Sync Settings' });

            new Setting(containerEl)
                .setName('Auto Sync')
                .setDesc('Automatically sync files at regular intervals')
                .addToggle(toggle => toggle
                    .setValue(this.plugin.settings.autoSync)
                    .onChange(async (value) => {
                        this.plugin.settings.autoSync = value;
                        await this.plugin.saveSettings();
                        if (value) {
                            this.plugin.startAutoSync();
                        } else {
                            this.plugin.stopAutoSync();
                        }
                    }));

            new Setting(containerEl)
                .setName('Sync Interval')
                .setDesc('How often to sync (in minutes)')
                .addSlider(slider => slider
                    .setLimits(1, 60, 1)
                    .setValue(this.plugin.settings.syncInterval)
                    .setDynamicTooltip()
                    .onChange(async (value) => {
                        this.plugin.settings.syncInterval = value;
                        await this.plugin.saveSettings();
                        if (this.plugin.settings.autoSync) {
                            this.plugin.startAutoSync();
                        }
                    }));

            new Setting(containerEl)
                .setName('Use Legacy Sync')
                .setDesc('Enable to use old sync method (no version control). Only use if you have sync issues.')
                .addToggle(toggle => toggle
                    .setValue(this.plugin.settings.useLegacySync)
                    .onChange(async (value) => {
                        this.plugin.settings.useLegacySync = value;
                        await this.plugin.saveSettings();
                        this.plugin.networkClient.setUseLegacySync(value);
                    }));

            // ===== Sync Actions =====
            containerEl.createEl('h3', { text: '⚡ Sync Actions' });

            new Setting(containerEl)
                .setName('Sync Now')
                .setDesc('Manually trigger a full vault sync')
                .addButton(button => button
                    .setButtonText('🔄 Sync Now')
                    .setCta()
                    .onClick(async () => {
                        button.setButtonText('Syncing...');
                        button.setDisabled(true);
                        await this.plugin.performSync();
                        button.setButtonText('🔄 Sync Now');
                        button.setDisabled(false);
                    }));

            new Setting(containerEl)
                .setName('View Status')
                .setDesc('Check sync status and storage usage')
                .addButton(button => button
                    .setButtonText('📊 View Status')
                    .onClick(async () => {
                        button.setButtonText('Loading...');
                        button.setDisabled(true);

                        const status = await this.plugin.networkClient.getSyncStatus();

                        button.setButtonText('📊 View Status');
                        button.setDisabled(false);

                        if (status.success && status.status) {
                            const s = status.status;
                            const usedMB = (s.storage.used / 1024 / 1024).toFixed(2);
                            new Notice(
                                `📊 Sync Status\n` +
                                `User: ${s.user.email}\n` +
                                `Files: ${s.files.count}\n` +
                                `Storage: ${usedMB} MB`,
                                10000
                            );
                        } else {
                            new Notice(`❌ Failed to get status: ${status.error}`);
                        }
                    }));
        }
    }

    /**
     * Update server status display
     */
    private async updateServerStatus(container: HTMLElement): Promise<void> {
        container.empty();
        container.createEl('span', { text: 'Checking server...', cls: 'sync-status-checking' });

        const isHealthy = await this.plugin.networkClient.checkHealth();

        container.empty();
        if (isHealthy) {
            const serverInfo = await this.plugin.networkClient.getServerInfo();
            if (serverInfo) {
                container.createEl('div', {
                    text: `✅ Connected to ${serverInfo.service} v${serverInfo.version}`,
                    cls: 'sync-status-connected'
                });
            } else {
                container.createEl('div', {
                    text: '✅ Server is healthy',
                    cls: 'sync-status-connected'
                });
            }
        } else {
            container.createEl('div', {
                text: '❌ Cannot connect to server',
                cls: 'sync-status-disconnected'
            });
        }
    }

    /**
     * Update authentication status display
     */
    private async updateAuthStatus(container: HTMLElement): Promise<void> {
        container.empty();

        if (!this.plugin.settings.token) {
            container.createEl('div', {
                text: '🔒 Not authenticated - Please enter your API token',
                cls: 'sync-status-not-auth'
            });
            return;
        }

        container.createEl('span', { text: 'Verifying token...', cls: 'sync-status-checking' });

        const result = await this.plugin.networkClient.verifyToken();

        container.empty();
        if (result.success && result.user) {
            container.createEl('div', {
                text: `✅ Authenticated as: ${result.user.email} (${result.user.role})`,
                cls: 'sync-status-authenticated'
            });
        } else {
            container.createEl('div', {
                text: `⚠️ Token invalid: ${result.error}`,
                cls: 'sync-status-invalid'
            });
        }
    }
}
