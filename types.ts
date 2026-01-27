/**
 * Plugin Settings Interface
 */
export interface SyncPluginSettings {
    token: string;
    deviceName: string;
    autoSync: boolean;
    syncInterval: number; // in minutes
    deviceId: string;
    useLegacySync: boolean;
}

/**
 * Default plugin settings
 */
export const DEFAULT_SETTINGS: SyncPluginSettings = {
    token: '',
    deviceName: 'Obsidian Device',
    autoSync: false,
    syncInterval: 5,
    deviceId: '', // Will be generated on load if empty
    useLegacySync: false,
};

export const SERVER_URL = 'https://api.honos.dev';

/**
 * User info from API
 */
export interface UserInfo {
    id: string;
    email: string;
    role: 'user' | 'admin';
}

/**
 * Auth Verify Response
 */
export interface AuthVerifyResponse {
    success: boolean;
    user?: UserInfo;
    error?: string;
}

/**
 * File info from server
 */
export interface RemoteFile {
    id: string;
    path: string;
    hash: string;
    size: number;
    createdAt: string;
    updatedAt: string;
    revision?: number;
}

/**
 * File List Response
 */
export interface FileListResponse {
    success: boolean;
    files?: RemoteFile[];
    totalFiles?: number;
    totalSize?: number;
    error?: string;
}

/**
 * File Download Response
 */
export interface FileDownloadResponse {
    success: boolean;
    file?: {
        path: string;
        hash: string;
        size: number;
        updatedAt: string;
        revision?: number;
        parentRevision?: number;
    };
    content?: string;
    error?: string;
    isConflict?: boolean;
}

/**
 * File Upload Response
 */
export interface FileUploadResponse {
    success: boolean;
    message?: string;
    file?: {
        id: string;
        path: string;
        hash: string;
        size: number;
        revision?: number;
    };
    error?: string;
    conflict?: ConflictInfo;
}

/**
 * File Delete Response
 */
export interface FileDeleteResponse {
    success: boolean;
    message?: string;
    deletedFile?: {
        path: string;
        size: number;
    };
    error?: string;
    conflict?: ConflictInfo;
}

/**
 * Recent Activity
 */
export interface RecentActivity {
    id: string;
    action: 'upload' | 'download' | 'delete';
    filePath: string;
    timestamp: string;
}

/**
 * Sync Status Response
 */
export interface SyncStatusResponse {
    success: boolean;
    status?: {
        connected: boolean;
        user: {
            id: string;
            email: string;
        };
        storage: {
            used: number;
        };
        files: {
            count: number;
        };
        recentActivity: RecentActivity[];
    };
    error?: string;
}

/**
 * API Error Response
 */
export interface APIErrorResponse {
    error: string;
}

/**
 * Generic API Response
 */
export interface APIResponse<T = any> {
    success?: boolean;
    data?: T;
    error?: string;
    message?: string;
}

/**
 * Local File Metadata for Version Control
 */
export interface LocalFileMetadata {
    path: string;
    hash: string;
    size: number;
    revision: number;
    parentRevision: number;
    lastSyncedAt: number;
    deviceId?: string;
}

/**
 * Conflict Info from Server
 */
export interface ConflictInfo {
    currentRevision: number;
    yourParentRevision: number;
    conflictFile: {
        revision: number;
        hash: string;
        updatedAt: string;
        deviceId: string;
    };
}
