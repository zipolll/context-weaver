import { defineConfig } from 'wxt';
import { PLATFORM_MATCHES } from './src/adapters/platforms';
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'UniFAI',
    description: '在原来的 AI 页面整理对话、定位轮次、串联来源与复用上下文。',
    version: '0.3.7',
    minimum_chrome_version: '116',
    permissions: ['storage', 'sidePanel', 'contextMenus', 'activeTab', 'scripting'],
    host_permissions: PLATFORM_MATCHES,
    optional_host_permissions: ['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*'],
    action: { default_title: '打开 UniFAI' },
    side_panel: { default_path: 'sidepanel.html' }
  }
});
