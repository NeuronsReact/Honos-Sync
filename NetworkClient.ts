import { requestUrl } from 'obsidian';
import {
    AuthVerifyResponse,
    FileListResponse,
    FileDownloadResponse,
    FileUploadResponse,
    FileDeleteResponse,
    SyncStatusResponse,
    RemoteFile,
} from './types';

/**
 * NetworkClient - Handles all API communication with Honos-Core backend
 * 
 * API Base Paths:
 * - /obsidian/* - Obsidian plugin endpoints (requires API Token)
 */
export class NetworkClient {
    private baseUrl: string;
    private token: string;
    private deviceName: string;
    private useLegacySync: boolean = false;

    constructor(baseUrl: string, token: string = '', deviceName: string = '') {
        this.baseUrl = baseUrl.replace(/\/$/, ''); // Remove trailing slash
        this.token = token;
        this.deviceName = deviceName;
    }

    /**
     * Update the authentication token
     */
    setToken(token: string): void {
        this.token = token;
    }

    /**
     * Update the device name
     */
    setDeviceName(deviceName: string): void {
        this.deviceName = deviceName;
    }

    /**
     * Set sync mode
     */
    setUseLegacySync(useLegacy: boolean): void {
        this.useLegacySync = useLegacy;
    }

    /**
     * Get API base path based on sync mode
     */
    private getApiBase(endpoint: string): string {
        // Auth and Status are always on root /obsidian or sharedv1
        if (endpoint === 'auth' || endpoint === 'status') {
            return `${this.baseUrl}/obsidian`;
        }

        // File operations depend on version
        return this.useLegacySync
            ? `${this.baseUrl}/obsidian`
            : `${this.baseUrl}/obsidian/v2`;
    }

    /**
     * Get common headers for authenticated requests
     */
    private getAuthHeaders(): Record<string, string> {
        return {
            'Authorization': `Bearer ${this.token}`,
            'Content-Type': 'application/json',
        };
    }

    /**
     * Verify API Token and get user info
     * GET /obsidian/auth/verify
     */
    async verifyToken(): Promise<AuthVerifyResponse> {
        try {
            const response = await requestUrl({
                url: `${this.baseUrl}/obsidian/auth/verify`,
                method: 'GET',
                headers: this.getAuthHeaders(),
            });

            if (response.status === 200) {
                const data = response.json;
                return {
                    success: true,
                    user: data.user,
                };
            } else {
                return {
                    success: false,
                    error: response.json?.error || 'Token verification failed',
                };
            }
        } catch (error: any) {
            console.error('Error verifying token:', error);
            return {
                success: false,
                error: error?.message || 'Failed to verify token. Please check your connection.',
            };
        }
    }

    /**
     * Get all files list
     * GET /obsidian/files
     */
    async listFiles(): Promise<FileListResponse> {
        try {
            const apiBase = this.getApiBase('files');
            const response = await requestUrl({
                url: `${apiBase}/files`,
                method: 'GET',
                headers: this.getAuthHeaders(),
            });

            if (response.status === 200) {
                const data = response.json;
                return {
                    success: true,
                    files: data.files || [],
                    totalFiles: data.totalFiles,
                    totalSize: data.totalSize,
                };
            } else {
                return this.handleErrorResponse(response);
            }
        } catch (error: any) {
            console.error('Error listing files:', error);
            return {
                success: false,
                error: error?.message || 'Failed to list files.',
            };
        }
    }

    /**
     * Download a file
     * GET /obsidian/files/{path}
     */
    async downloadFile(filePath: string, revision?: number): Promise<FileDownloadResponse> {
        try {
            const apiBase = this.getApiBase('files');
            const encodedPath = encodeURIComponent(filePath);
            let url = `${apiBase}/files/${encodedPath}`;

            if (revision !== undefined && !this.useLegacySync) {
                url += `?revision=${revision}`;
            }

            const response = await requestUrl({
                url: url,
                method: 'GET',
                headers: this.getAuthHeaders(),
            });

            if (response.status === 200) {
                const data = response.json;
                return {
                    success: true,
                    file: data.file,
                    content: data.content,
                    isConflict: data.isConflict,
                };
            } else {
                return this.handleErrorResponse(response);
            }
        } catch (error: any) {
            console.error('Error downloading file:', error);
            return {
                success: false,
                error: error?.message || 'Failed to download file.',
            };
        }
    }

    /**
     * Upload or update a file
     * POST /obsidian/upload
     */
    async uploadFile(
        filePath: string,
        content: ArrayBuffer | string,
        options: { parentRevision?: number, deviceId?: string } = {}
    ): Promise<FileUploadResponse> {
        try {
            // Convert ArrayBuffer to string if needed
            let contentString: string;
            if (content instanceof ArrayBuffer) {
                contentString = new TextDecoder().decode(content);
            } else {
                contentString = content;
            }

            const apiBase = this.getApiBase('files');
            const body: any = {
                path: filePath,
                content: contentString,
            };

            if (!this.useLegacySync) {
                if (options.parentRevision !== undefined) body.parentRevision = options.parentRevision;
                if (options.deviceId) body.deviceId = options.deviceId;
            }

            const response = await requestUrl({
                url: `${apiBase}/upload`,
                method: 'POST',
                headers: this.getAuthHeaders(),
                body: JSON.stringify(body),
                throw: false // Handle 409 manualy
            });

            if (response.status === 200 || response.status === 201) {
                const data = response.json;
                return {
                    success: true,
                    message: data.message || 'File uploaded successfully',
                    file: data.file,
                };
            } else if (response.status === 409) {
                const data = response.json;
                return {
                    success: false,
                    error: 'Conflict detected',
                    conflict: data.conflict,
                };
            } else {
                return this.handleErrorResponse(response);
            }
        } catch (error: any) {
            console.error('Error uploading file:', error);
            return {
                success: false,
                error: error?.message || 'Failed to upload file.',
            };
        }
    }

    /**
     * Delete a file
     * DELETE /obsidian/files/{path}
     */
    async deleteFile(
        filePath: string,
        options: { parentRevision?: number, deviceId?: string } = {}
    ): Promise<FileDeleteResponse> {
        try {
            const apiBase = this.getApiBase('files');
            const encodedPath = encodeURIComponent(filePath);

            const reqOptions: any = {
                url: `${apiBase}/files/${encodedPath}`,
                method: 'DELETE',
                headers: this.getAuthHeaders(),
                throw: false
            };

            if (!this.useLegacySync) {
                reqOptions.body = JSON.stringify({
                    parentRevision: options.parentRevision,
                    deviceId: options.deviceId
                });
            }

            const response = await requestUrl(reqOptions);

            if (response.status === 200) {
                const data = response.json;
                return {
                    success: true,
                    message: data.message || 'File deleted successfully',
                    deletedFile: data.deletedFile,
                };
            } else if (response.status === 409) {
                const data = response.json;
                return {
                    success: false,
                    error: 'Conflict detected during deletion',
                    conflict: data.conflict
                };
            } else {
                return this.handleErrorResponse(response);
            }
        } catch (error: any) {
            console.error('Error deleting file:', error);
            return {
                success: false,
                error: error?.message || 'Failed to delete file.',
            };
        }
    }

    /**
     * Attempt auto-merge for conflicted file
     * POST /obsidian/v2/conflicts/auto-merge
     */
    async attemptAutoMerge(params: {
        filePath: string;
        ourContent: string;
        ancestorRevision: number;
        theirRevision: number;
    }): Promise<any> {
        try {
            const response = await requestUrl({
                url: `${this.baseUrl}/obsidian/v2/conflicts/auto-merge`,
                method: 'POST',
                headers: this.getAuthHeaders(),
                body: JSON.stringify(params),
            });

            if (response.status === 200) {
                return response.json;
            } else {
                return { success: false, error: 'Auto-merge failed server-side' };
            }
        } catch (error) {
            console.error('Error attempting auto-merge:', error);
            return { success: false, error: 'Auto-merge network error' };
        }
    }

    /**
     * Get sync status
     * GET /obsidian/status
     */
    async getSyncStatus(): Promise<SyncStatusResponse> {
        try {
            const response = await requestUrl({
                url: `${this.baseUrl}/obsidian/status`,
                method: 'GET',
                headers: this.getAuthHeaders(),
            });

            if (response.status === 200) {
                const data = response.json;
                return {
                    success: true,
                    status: data.status,
                };
            } else {
                return this.handleErrorResponse(response);
            }
        } catch (error: any) {
            console.error('Error getting sync status:', error);
            return {
                success: false,
                error: error?.message || 'Failed to get sync status.',
            };
        }
    }

    /**
     * Check server health
     * GET /health
     */
    async checkHealth(): Promise<boolean> {
        try {
            const response = await requestUrl({
                url: `${this.baseUrl}/health`,
                method: 'GET',
            });
            return response.status === 200 && response.json?.status === 'ok';
        } catch (error) {
            console.error('Health check failed:', error);
            return false;
        }
    }

    /**
     * Get server info
     * GET /
     */
    async getServerInfo(): Promise<{ service: string; version: string; status: string } | null> {
        try {
            const response = await requestUrl({
                url: `${this.baseUrl}/`,
                method: 'GET',
            });
            if (response.status === 200) {
                return response.json;
            }
            return null;
        } catch (error) {
            console.error('Error getting server info:', error);
            return null;
        }
    }

    /**
     * Handle API error responses
     */
    private handleErrorResponse(response: any): { success: false; error: string } {
        const status = response.status;
        const data = response.json;

        if (status === 401) {
            return {
                success: false,
                error: 'Unauthorized: Invalid or expired API token. Please check your token.',
            };
        } else if (status === 403) {
            return {
                success: false,
                error: 'Forbidden: You do not have permission to perform this action.',
            };
        } else if (status === 404) {
            return {
                success: false,
                error: 'Not found: The requested resource does not exist.',
            };
        } else {
            return {
                success: false,
                error: data?.error || `Request failed with status ${status}`,
            };
        }
    }
}
