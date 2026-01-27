# Honos Sync - Obsidian 同步插件

通过 [Honos-Core](https://github.com/nextroad/honos-core) 后端服务器同步您的 Obsidian 仓库。

> ⚠️ **重要提示**：本服务目前为**非公共服务**，仅供特定用户使用。如需使用，请联系管理员获取访问权限和 API 令牌。

## 功能特性

- 🔐 **安全认证** - 基于 API Token 的身份验证
- 📁 **全库同步** - 将整个仓库同步到服务器
- 🔄 **自动同步** - 可配置的自动同步间隔
- 📊 **状态仪表盘** - 查看同步状态和存储使用情况
- 💻 **多设备支持** - 跨多个设备同步

## 安装教程

### 方式一：Windows 手动安装

1. 从 [Releases](https://github.com/nextroad/honos-sync-client/releases) 页面下载最新发布版本
2. 解压下载的文件
3. 找到你的 Obsidian 仓库文件夹，进入 `.obsidian/plugins/` 目录
   - 如果 `plugins` 文件夹不存在，请手动创建
4. 在 `plugins` 目录下创建 `honos-sync` 文件夹
5. 将解压出的 `main.js`、`manifest.json` 和 `styles.css` 文件复制到 `honos-sync` 文件夹中
6. 重启 Obsidian
7. 进入 **设置** → **第三方插件**，关闭**安全模式**（如尚未关闭）
8. 在已安装插件列表中找到 **Honos Sync** 并启用

### 方式二：Android 使用 BRAT 安装

[BRAT (Beta Reviewers Auto-update Tester)](https://github.com/TfTHacker/obsidian42-brat) 是一个用于安装和更新 Obsidian 测试版插件的插件。

#### 步骤 1：安装 BRAT 插件

1. 打开 Obsidian，进入 **设置** → **第三方插件**
2. 确保已关闭**安全模式**
3. 点击 **浏览社区插件**
4. 搜索 **BRAT**
5. 安装并启用 **Obsidian42 - BRAT**

#### 步骤 2：通过 BRAT 添加 Honos Sync

1. 进入 **设置** → **Obsidian42 - BRAT**
2. 点击 **Add Beta plugin**
3. 在输入框中粘贴以下仓库地址：
   ```
   https://github.com/nextroad-dev/Honos-Sync
   ```
4. 点击 **Add Plugin**
5. 等待 BRAT 下载并安装插件
6. 进入 **设置** → **第三方插件**，在列表中找到 **Honos Sync** 并启用

#### BRAT 的优势

- 📦 自动从 GitHub 下载最新版本
- 🔄 支持自动更新检查
- 📱 特别适合移动端用户

### 方式三：手动构建

```bash
# 克隆仓库
git clone https://github.com/nextroad/honos-sync-client.git
cd honos-sync-client

# 安装依赖
npm install

# 构建插件
npm run build

# 将文件复制到你的仓库
cp main.js manifest.json styles.css /path/to/vault/.obsidian/plugins/honos-sync/
```

## 配置教程

### 1. 获取 API 令牌

1. 联系管理员申请账户访问权限
2. 登录 Honos-Core 网页控制台
3. 导航到 **API Tokens（API 令牌）** 部分
4. 点击 **Create New Token（创建新令牌）**
5. 复制令牌（令牌只显示一次，请妥善保存！）

### 2. 配置插件

1. 打开 Obsidian 设置
2. 进入 **第三方插件** → **Honos Sync**
3. 粘贴你的 **API 令牌**
4. 点击 **验证令牌** 确认连接正常
5. 可选：启用 **自动同步** 并设置同步间隔

## 使用方法

### 手动同步

- 点击左侧功能区的**同步图标**，或
- 使用命令面板：`Honos Sync: Sync vault now`

### 检查状态

- 使用命令面板：`Honos Sync: Check sync status`
- 或在设置中点击 **查看状态**
- 状态栏右下角会显示当前同步状态

## API 端点说明

本插件与以下 Honos-Core API 端点通信：

| 端点 | 方法 | 描述 |
|------|------|------|
| `/obsidian/auth/verify` | GET | 验证 API 令牌 |
| `/obsidian/files` | GET | 列出所有同步文件 |
| `/obsidian/files/{path}` | GET | 下载文件 |
| `/obsidian/upload` | POST | 上传/更新文件 |
| `/obsidian/files/{path}` | DELETE | 删除文件 |
| `/obsidian/status` | GET | 获取同步状态 |
| `/health` | GET | 服务器健康检查 |

## 支持的文件类型

本插件同步以下文件类型：
- Markdown (`.md`)
- 文本 (`.txt`)
- JSON (`.json`)
- CSS (`.css`)
- JavaScript (`.js`)
- HTML (`.html`)
- XML (`.xml`)
- YAML (`.yaml`, `.yml`)

## 开发与发布

### 本地开发

```bash
# 安装依赖
npm install

# 开发模式（监听文件变化）
npm run dev

# 生产构建
npm run build

# 类型检查
npx tsc --noEmit
```

## 更新日志

### v2.3.0

- 🔄 **全新 V2 核心**：全面重构同步引擎，支持增量同步
- ⚡ **性能提升**：基于版本控制的智能同步，显著减少流量消耗
- 🛡️ **冲突处理**：新增冲突检测与自动解决机制
- 📱 **设备标识**：支持多设备独立标识

### v2.0.0

- 🔄 为 Honos-Core API v2.0.0 重写
- 🔐 从会话认证切换到 API Token 认证
- ✨ 添加自动同步功能
- 📊 添加同步状态显示
- 🎨 改进设置界面

### v1.0.0

- 初始版本发布

## 许可证

MIT 许可证

