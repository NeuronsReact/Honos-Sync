import { requestUrl } from 'obsidian';
import {
    AuthVerifyResponse,
    FileListResponse,
    FileDownloadResponse,
    FileUploadResponse,
    FileDeleteResponse,
    SyncStatusResponse,
} from './types';

/**
 * NetworkClient - Handles V2 API communication
 */
export class NetworkClient {
    private baseUrl: string;
    private token: string;
    private deviceName: string;

    constructor(baseUrl: string, token: string = '', deviceName: string = '') {
        this.baseUrl = baseUrl.replace(/\/$/, ''); // Remove trailing slash
        this.token = token;
        this.deviceName = deviceName;
    }

    setToken(token: string): void {
        this.token = token;
    }

    setDeviceName(deviceName: string): void {
        this.deviceName = deviceName;
    }

    private getAuthHeaders(): Record<string, string> {
        return {
            'Authorization': `Bearer ${this.token}`,
            'Content-Type': 'application/json',
        };
    }

    /**
     * V2 List Files
     */
    async listFiles(): Promise<FileListResponse> {
        try {
            const response = await requestUrl({
                url: `${this.baseUrl}/obsidian/v2/files`,
                method: 'GET',
                headers: this.getAuthHeaders(),
            });

            if (response.status === 200) {
                return response.json;
            }
            return this.handleErrorResponse(response);
        } catch (error: any) {
            console.error('Error listing files:', error);
            return {
                success: false,
                error: error?.message || 'Failed to list files.',
            };
        }
    }

    /**
     * V2 Download File
     */
    async downloadFile(filePath: string, revision?: number): Promise<FileDownloadResponse> {
        try {
            const encodedPath = encodeURIComponent(filePath);
            const query = revision ? `?revision=${revision}` : '';
            const response = await requestUrl({
                url: `${this.baseUrl}/obsidian/v2/files/${encodedPath}${query}`,
                method: 'GET',
                headers: this.getAuthHeaders(),
            });

            if (response.status === 200) {
                // V2 response structure: { success: true, file: { ..., content: "..." } }
                return response.json;
            }
            return this.handleErrorResponse(response);
        } catch (error: any) {
            console.error('Error downloading file:', error);
            return {
                success: false,
                error: error?.message || 'Failed to download file.',
            };
        }
    }

    /**
     * V2 Upload File
     */
    async uploadFile(
        filePath: string,
        chunks: string[],
        hash: string,
        size: number,
        parentRevision: number
    ): Promise<FileUploadResponse> {
        try {
            const response = await requestUrl({
                url: `${this.baseUrl}/obsidian/v2/upload`,
                method: 'POST',
                headers: this.getAuthHeaders(),
                body: JSON.stringify({
                    filePath,
                    hash,
                    size,
                    parentRevision,
                    deviceId: this.deviceName,
                    chunks
                }),
            });

            if (response.status === 200) {
                return response.json;
            }
            // Handle Conflict (409)
            if (response.status === 409) {
                return response.json; // Should contain conflict data
            }

            return this.handleErrorResponse(response);
        } catch (error: any) {
            console.error('Error uploading file:', error);
            return {
                success: false,
                error: error?.message || 'Failed to upload file.',
            };
        }
    }

    /**
     * V2 Delete File
     */
    async deleteFile(filePath: string, parentRevision: number): Promise<FileDeleteResponse> {
        try {
            const encodedPath = encodeURIComponent(filePath);
            const response = await requestUrl({
                url: `${this.baseUrl}/obsidian/v2/files/${encodedPath}`,
                method: 'DELETE',
                headers: this.getAuthHeaders(),
                body: JSON.stringify({
                    parentRevision,
                    deviceId: this.deviceName
                })
            });

            if (response.status === 200 || response.status === 409) {
                return response.json;
            }
            return this.handleErrorResponse(response);
        } catch (error: any) {
            console.error('Error deleting file:', error);
            return {
                success: false,
                error: error?.message || 'Failed to delete file.',
            };
        }
    }

    // ... Keep legacy verify/status methods if needed for backward compatibility or general use

    async verifyToken(): Promise<AuthVerifyResponse> {
        // Use token-auth endpoint
        try {
            const response = await requestUrl({
                url: `${this.baseUrl}/obsidian/auth/verify`,
                method: 'GET',
                headers: this.getAuthHeaders(),
            });

            if (response.status === 200) {
                const data = response.json;
                return { success: true, user: data.user };
            }
            return { success: false, error: 'Token invalid' };
        } catch (e: any) {
            return { success: false, error: e.message };
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
     * Get legacy sync status
     */
    async getSyncStatus(): Promise<SyncStatusResponse> {
        try {
            const response = await requestUrl({
                url: `${this.baseUrl}/obsidian/status`,
                method: 'GET',
                headers: this.getAuthHeaders(),
            });

            if (response.status === 200) {
                return response.json;
            }
            return this.handleErrorResponse(response);
        } catch (error: any) {
            return { success: false, error: error?.message || 'Failed to get sync status' };
        }
    }

    /**
     * Check health
     */
    async checkHealth(): Promise<boolean> {
        try {
            const response = await requestUrl({
                url: `${this.baseUrl}/api/info`,
                method: 'GET',
            });
            return response.status === 200;
        } catch {
            return false;
        }
    }

    /**
     * Get server info
     */
    async getServerInfo(): Promise<any> {
        try {
            const response = await requestUrl({
                url: `${this.baseUrl}/api/info`,
                method: 'GET',
            });
            return response.status === 200 ? response.json : null;
        } catch {
            return null;
        }
    }

    private handleErrorResponse(response: any): { success: false; error: string } {
        const status = response.status;
        const data = response.json;
        return {
            success: false,
            error: data?.error || `Request failed with status ${status}`,
        };
    }
}
