"use strict";

(function () {
    // --- 配置、常量与持久化 ---
    const SCRIPT_NAME = 'API秘钥管理器';
    const LOG_PREFIX = `[${SCRIPT_NAME}]`;
    const NAMESPACE = 'apiConfigManager'; // 在TavernHelper全局变量中的命名空间

    // UI相关常量
    const BUTTON_ID = 'api-config-manager-button';
    const PANEL_ID = 'api-config-manager-panel';
    const OVERLAY_ID = 'api-config-manager-overlay';
    const STYLE_ID = 'api-config-manager-styles';

    // [迁移专用] 旧版脚本的常量
    const OLD_SETTINGS_KEY = `st_api-config-manager_settings`;
    const OLD_DB_NAME = 'api-config-manager-db';
    const OLD_DB_VERSION = 1;
    const OLD_STORE_NAME = 'settings';
    const OLD_ENCRYPTION_KEY = `st_api-config-manager_encryption_key`;

    const DEFAULT_SETTINGS = {
        profiles: [{
            name: "默认配置",
            keys: [''],
            endpoint: "",
            models: ['']
        }]
    };

    let settings = {}; // 内存中的配置，从TavernHelper加载而来
    const parentDoc = window.parent.document;
    const parent$ = window.parent.jQuery || window.parent.$;


    // --- 核心功能 ---

    /* --- Helper & Logging Functions --- */
    function logMessage(message, type = 'info') { const fullMessage = `${LOG_PREFIX} ${message}`; switch (type) { case 'error': console.error(fullMessage); break; case 'warn': console.warn(fullMessage); break; default: console.log(fullMessage); } }
    function fallbackCopy(text, doc) { const $temp = parent$('<textarea>'); parent$('body', doc).append($temp); $temp.val(text).select(); let success = false; try { success = doc.execCommand('copy'); } catch (e) { logMessage(`复制失败: ${e.message}`, 'error'); } $temp.remove(); if (typeof toastr !== 'undefined') { if (success) { toastr.success('秘钥已复制到剪贴板'); } else { toastr.error('复制失败，请手动复制'); } } }

    /* --- [重构] 新的存储逻辑 --- */
    
    // [新增] 内部“纯净”保存函数，只负责将内存中的`settings`对象写入，不读取UI
    async function _saveSettingsDirectly() {
        try {
            await TavernHelper.updateVariablesWith((currentGlobalVars) => {
                const currentNamespaceData = currentGlobalVars[NAMESPACE] || {};
                const newNamespaceData = {
                    ...currentNamespaceData,
                    profiles: settings.profiles // 只更新profiles数组
                };
                return {
                    ...currentGlobalVars,
                    [NAMESPACE]: newNamespaceData
                };
            }, { type: 'global' });
            return true;
        } catch (error) {
            logMessage(`通过TavernHelper保存配置失败: ${error.message}`, 'error');
            return false;
        }
    }

    // “智能”保存函数，用于关闭面板等常规操作
    async function saveSettings() {
        // 1. 从UI同步最新数据到内存中的 `settings` 对象 (保持原始数据流)
        await saveCurrentProfileData();
        // 2. 调用纯净保存函数
        const success = await _saveSettingsDirectly();
        // 删除内部的通知显示，统一在closeAndSave中处理
        return success;
    }

    // 新的加载函数：从TavernHelper全局变量中读取
    async function loadSettings() {
        try {
            const globalVars = await TavernHelper.getVariables({ type: 'global' });
            if (globalVars && globalVars[NAMESPACE] && Array.isArray(globalVars[NAMESPACE].profiles)) {
                settings = JSON.parse(JSON.stringify(globalVars[NAMESPACE]));
                logMessage(`从TavernHelper加载配置完成，共 ${settings.profiles.length} 个。`);
            } else {
                settings = JSON.parse(JSON.stringify({ profiles: DEFAULT_SETTINGS.profiles }));
                logMessage("未找到现有配置，使用默认配置。");
            }
        } catch (error) {
            logMessage(`从TavernHelper加载配置失败: ${error.message}`, 'error');
            settings = JSON.parse(JSON.stringify({ profiles: DEFAULT_SETTINGS.profiles }));
        }
    }

    /* --- [迁移专用] 一次性迁移逻辑 --- */
    async function _migration_loadEncryptionKey() {
        if (!window.crypto || !window.crypto.subtle) return null;
        try {
            const keyBase64 = localStorage.getItem(OLD_ENCRYPTION_KEY);
            if (!keyBase64) return null;
            const keyBytes = Uint8Array.from(atob(keyBase64), c => c.charCodeAt(0));
            return await window.crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
        } catch (err) { return null; }
    }
    async function _migration_decryptData(encryptedDataObj, encryptionKey) {
        if (!encryptedDataObj || typeof encryptedDataObj.encrypted === 'undefined') return encryptedDataObj;
        if (!encryptedDataObj.encrypted) return encryptedDataObj.data;
        if (!encryptionKey) throw new Error("解密失败：无可用加密密钥");
        const iv = Uint8Array.from(atob(encryptedDataObj.data.iv), c => c.charCodeAt(0));
        const encryptedBytes = Uint8Array.from(atob(encryptedDataObj.data.encryptedData), c => c.charCodeAt(0));
        const decryptedBytes = await window.crypto.subtle.decrypt({ name: "AES-GCM", iv: iv }, encryptionKey, encryptedBytes);
        return JSON.parse(new TextDecoder().decode(decryptedBytes));
    }
    function _migration_openDatabase() {
        return new Promise((resolve) => {
            if (!window.indexedDB) { resolve(null); return; }
            const request = indexedDB.open(OLD_DB_NAME, OLD_DB_VERSION);
            request.onerror = () => resolve(null);
            request.onsuccess = (event) => resolve(event.target.result);
            request.onupgradeneeded = (event) => { event.target.transaction.abort(); resolve(null); };
        });
    }
    function _migration_loadFromIndexedDB(db, encryptionKey) {
        return new Promise(async (resolve) => {
            if (!db) { resolve(null); return; }
            const transaction = db.transaction([OLD_STORE_NAME], "readonly");
            const request = transaction.objectStore(OLD_STORE_NAME).get(OLD_SETTINGS_KEY);
            request.onerror = () => resolve(null);
            request.onsuccess = async () => {
                if (request.result && request.result.value) {
                    try { resolve(await _migration_decryptData(request.result.value, encryptionKey)); } 
                    catch (e) { logMessage(`[迁移] 解密失败: ${e.message}`, 'error'); resolve(null); }
                } else { resolve(null); }
            };
        });
    }
    async function runMigrationIfNeeded() {
        const globalVars = await TavernHelper.getVariables({ type: 'global' });
        if (globalVars && globalVars[NAMESPACE] && globalVars[NAMESPACE].migrated) {
            logMessage("数据已迁移，跳过迁移过程。");
            return;
        }

        logMessage("开始执行一次性数据迁移...");
        let oldSettings = null;
        try {
            const encryptionKey = await _migration_loadEncryptionKey();
            const db = await _migration_openDatabase();
            if (db) {
                oldSettings = await _migration_loadFromIndexedDB(db, encryptionKey);
                db.close();
            }
            if (!oldSettings) {
                const stored = localStorage.getItem(OLD_SETTINGS_KEY);
                if (stored) oldSettings = JSON.parse(stored);
            }
        } catch (e) {
            logMessage(`[迁移] 读取旧数据时发生错误: ${e.message}`, 'error');
        }

        const dataToStore = oldSettings || { profiles: DEFAULT_SETTINGS.profiles };
        if (oldSettings) {
            logMessage(`[迁移] 成功读取旧配置，共 ${oldSettings.profiles.length} 个。`);
        } else {
            logMessage("[迁移] 未找到旧配置数据。");
        }
        
        await TavernHelper.updateVariablesWith((currentGlobalVars) => {
            return {
                ...currentGlobalVars,
                [NAMESPACE]: {
                    profiles: dataToStore.profiles,
                    migrated: true
                }
            };
        }, { type: 'global' });

        logMessage("迁移过程完成。");
    }

    /* --- 原始UI和数据流逻辑 (保持不变) --- */
    async function saveCurrentProfileData() {
        const $activeTab = parent$(`#${PANEL_ID} .profile-tab.active`);
        const $configUnit = parent$(`#${PANEL_ID} .config-unit`);
        if ($activeTab.length === 0 || $configUnit.length === 0) return;

        const activeIndex = parseInt($activeTab.data('index'));
        if (isNaN(activeIndex) || !settings.profiles || activeIndex >= settings.profiles.length) {
            return;
        }

        const name = $configUnit.find('.config-name').val()?.trim() || `配置 ${activeIndex + 1}`;
        const endpoint = $configUnit.find('.config-endpoint').val()?.trim() || '';

        const keys = [];
        const activeKeyIndex = parseInt($configUnit.find('.key-row').data('index')) || 0;
        for (let i = 0; i < settings.profiles[activeIndex].keys.length; i++) {
            if (i === activeKeyIndex) {
                keys[i] = $configUnit.find('.config-key').val()?.trim() || '';
            } else if (settings.profiles[activeIndex].keys[i] !== undefined) {
                keys[i] = settings.profiles[activeIndex].keys[i];
            }
        }

        const models = $configUnit.find('.config-model').map(function() {
            return parent$(this).val()?.trim() || '';
        }).get();

        if (keys.length === 0) keys.push('');
        if (models.length === 0) models.push('');

        settings.profiles[activeIndex] = { name, keys, endpoint, models };

        const tabName = name.length > 8 ? name.slice(0, 8) + '…' : name;
        $activeTab.text(tabName).attr('title', name);
    }

    /* 修改表单组结构，在模型标签旁添加加载按钮 */
    function createUnitElement(profile) {
        const currentProfile = profile || { name: '', keys: [''], endpoint: '', models: [''] };
        if (!currentProfile.keys || currentProfile.keys.length === 0) {
            currentProfile.keys = [''];
        }
        if (!currentProfile.models) {
            currentProfile.models = [''];
        }

        const $unit = parent$(`<div class="config-unit">
            <div class="form-group">
                <label>配置名称</label>
                <input type="text" class="config-name" placeholder="为此配置命名" value="${currentProfile.name || ''}">
            </div>
            <div class="form-group">
                <label>API接口地址</label>
                <input type="text" class="config-endpoint" placeholder="例如 https://api.openai.com/v1" value="${currentProfile.endpoint || ''}">
            </div>
            <div class="form-group">
                <label>秘钥</label>
                <div class="keys-container"></div>
            </div>
            <div class="form-group">
                <label>
                    模型
                    <span class="fetch-models-btn" title="获取模型列表"><i class="fa-solid fa-sync"></i></span>
                </label>
                <div class="models-container"></div>
            </div>
        </div>`);

        const $keysContainer = $unit.find('.keys-container');
        addKeyInput($keysContainer, currentProfile.keys[0] || '', 0);

        const $modelsContainer = $unit.find('.models-container');
        if (currentProfile.models.length > 0) {
            currentProfile.models.forEach((model) => {
                addModelInput($modelsContainer, model);
            });
        } else {
            addModelInput($modelsContainer, '');
        }
        updateModelRemoveButtons($modelsContainer);

        return $unit;
    }

    function addKeyInput($container, value = '', index) {
        $container.empty();
        
        const $keyRow = parent$(`
            <div class="key-row" data-index="${index}">
                <input type="text" class="config-key" placeholder="秘钥" value="${value}">
                <button class="menu_button api-keys-dropdown-btn" title="KEY列表">
                    <i class="fa-solid fa-angles-down"></i>
                </button>
            </div>`);
        $container.append($keyRow);
    }

    function addModelInput($container, value = '') {
        const $modelRow = parent$(`
            <div class="model-row">
                <input type="text" class="config-model" placeholder="模型名称" value="${value}">
                <div class="model-actions">
                    <button class="menu_button apply-model-btn" title="应用"><i class="fa-solid fa-check"></i></button>
                    <button class="menu_button add-model-btn" title="添加">+</button>
                    <button class="menu_button menu_button_bad remove-model-btn" title="删除">−</button>
                </div>
            </div>`);
        $container.append($modelRow);
        updateModelRemoveButtons($container);
    }

    function updateModelRemoveButtons($container) {
        const $modelRows = $container.find('.model-row');
        $modelRows.find('.remove-model-btn').css('display', $modelRows.length > 1 ? 'flex' : 'none');
    }

    function createApiKeyDropdown(keys = [], currentIndex) {
        const $dropdown = parent$('<div class="api-key-dropdown"></div>');

        keys.forEach((key, index) => {
            const displayText = key ? `${key.substr(0, 8)}...` : `(空) 秘钥 ${index + 1}`;
            const isActive = index === currentIndex;
            $dropdown.append(`<div class="api-key-item ${isActive ? 'active' : ''}" data-index="${index}">
                ${displayText}
                <span class="delete-key-btn" data-index="${index}" title="删除此秘钥"><i class="fa-solid fa-trash-can"></i></span>
            </div>`);
        });

        $dropdown.append('<div class="api-key-item add-new-api">+ 添加新KEY</div>');
        return $dropdown;
    }

    function renderProfileTabs(activeIndex) {
        const $container = parent$(`#${PANEL_ID} .profile-tabs-container`);
        if (!$container.length) return;
        let currentActiveIndex;
        if (typeof activeIndex === 'number' && !isNaN(activeIndex)) {
            currentActiveIndex = activeIndex;
        } else {
            const $oldActive = $container.find('.profile-tab.active');
            currentActiveIndex = parseInt(parent$($oldActive).data('index'));
            if (isNaN(currentActiveIndex)) currentActiveIndex = 0;
        }
        $container.empty();
        if (!settings.profiles || settings.profiles.length === 0) {
            settings.profiles = [ JSON.parse(JSON.stringify(DEFAULT_SETTINGS.profiles[0])) ];
        }
        settings.profiles.forEach((profile, index) => {
            let tabName = profile.name || `配置 ${index + 1}`;
            if (tabName.length > 8) tabName = tabName.slice(0, 8) + '…';
            const $tab = parent$(
              `<div class="profile-tab" data-index="${index}" draggable="true" title="${profile.name || `配置 ${index + 1}`}">${tabName}</div>`
            );
            if (index === currentActiveIndex) {
                $tab.addClass('active');
            }
            $container.append($tab);
        });
        if ($container.find('.profile-tab.active').length === 0 && settings.profiles.length > 0) {
            $container.find('.profile-tab').first().addClass('active');
        }
        initDragAndDrop();
    }

    function renderConfigUnits() { const $container = parent$(`#${PANEL_ID} .config-units-container`); const $activeTab = parent$(`#${PANEL_ID} .profile-tab.active`); if (!$container.length || $activeTab.length === 0) return; $container.empty(); const activeIndex = parseInt($activeTab.data('index')); if (isNaN(activeIndex) || !settings.profiles || activeIndex >= settings.profiles.length) { logMessage(`渲染失败：无效的激活索引 ${activeIndex}`, 'error'); $container.html('<p style="text-align:center; color: #ff5555;">错误：无法加载选中的配置数据。</p>'); return; } const activeProfile = settings.profiles[activeIndex]; const $unitElement = createUnitElement(activeProfile); $container.append($unitElement); }
    function updatePanel() { renderProfileTabs(); renderConfigUnits(); }

    function cleanupOldUI() { parent$(`#${BUTTON_ID}, #${OVERLAY_ID}, #${STYLE_ID}`).remove(); }
    
    /* 添加模型列表下拉菜单创建函数 */
    function createModelListDropdown(models = []) {
        const $dropdown = parent$('<div class="model-list-dropdown"></div>');
        
        if (models.length === 0) {
            $dropdown.append('<div class="model-list-item no-models">未找到可用模型</div>');
        } else {
            models.forEach((model) => {
                $dropdown.append(`<div class="model-list-item" data-model-id="${model.id}">${model.id}</div>`);
            });
        }
        
        return $dropdown;
    }

    /* 添加模型获取函数 */
    async function fetchModelsList(endpoint, apiKey) {
        try {
            // 判断API类型并构造请求
            let url = endpoint;
            if (!url.endsWith('/')) url += '/';
            
            // 默认假设是OpenAI API
            if (url.includes('openai.com') || !url.includes('azure')) {
                url += 'models';
            } else if (url.includes('azure')) {
                // Azure OpenAI 需要特殊处理
                // 提取部署名称等信息，这里简化处理
                url += 'models';
            }
            
            const headers = {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            };
            
            const response = await fetch(url, {
                method: 'GET',
                headers: headers
            });
            
            if (!response.ok) {
                throw new Error(`请求失败: ${response.status} ${response.statusText}`);
            }
            
            const data = await response.json();
            
            // 根据返回格式处理数据
            let models = [];
            if (data.data && Array.isArray(data.data)) {
                // OpenAI格式
                models = data.data.map(model => ({
                    id: model.id,
                    name: model.id
                }));
            } else if (data.models && Array.isArray(data.models)) {
                // 某些API可能使用这种格式
                models = data.models.map(model => ({
                    id: model.id || model.name,
                    name: model.name || model.id
                }));
            } else if (Array.isArray(data)) {
                // 简单数组格式
                models = data.map(model => ({
                    id: model.id || model,
                    name: model.name || model
                }));
            }
            
            logMessage(`API返回数据: ${JSON.stringify(data).substring(0, 200)}...`);
            logMessage(`处理后模型数量: ${models.length}`);
            
            return models;
        } catch (error) {
            logMessage(`获取模型列表失败: ${error.message}`, 'error');
            if (typeof toastr !== 'undefined') {
                toastr.error(`获取模型列表失败: ${error.message}`);
            }
            return [];
        }
    }

    /* 添加模型分类和过滤函数 - 降低过滤严格性 */
    function filterAndCategorizeModels(models) {
        // 前缀过滤规则 - 添加新的过滤项
        const prefixFilters = [
            'dall-e', 'stable-diffusion', 'sdxl', 'flux',
            'tts', 'whisper', 'video', 'embedding', 'reranker', 'coder',
            'qwen2.5', 'baai'  // 添加新的过滤条件
        ];

        // 添加调试输出
        logMessage(`过滤前模型数量: ${models.length}`);

        // 过滤模型 - 放宽条件
        const filteredModels = models.filter(model => {
            const modelId = model.id.toLowerCase();
            
            // 应用前缀过滤 - 精确匹配关键词，而不是简单的includes
            for (const filter of prefixFilters) {
                // 只过滤明确包含这些术语的模型，避免过度过滤
                const filterPattern = new RegExp(`\\b${filter}\\b`, 'i');
                if (filterPattern.test(modelId)) {
                    return false;
                }
                
                // 对于qwen2.5和baai特别处理，使用includes而不是精确匹配
                if ((filter === 'qwen2.5' || filter === 'baai') && 
                    modelId.includes(filter.toLowerCase())) {
                    return false;
                }
            }

            // 应用参数过滤 (-XB 规则) - 保持不变但增加调试
            const sizeMatch = modelId.match(/-(\d+)b\b/i);
            if (sizeMatch && parseInt(sizeMatch[1]) < 27) {
                return false;
            }

            return true;
        });

        // 添加调试输出
        logMessage(`过滤后模型数量: ${filteredModels.length}`);
        
        // 如果过滤后没有模型，返回原始模型
        if (filteredModels.length === 0) {
            logMessage(`过滤条件太严格，显示所有模型`);
            return categorizeAllModels(models);
        }

        // 按类别分组 - 保持不变
        const categories = {
            gemini: [],
            claude: [],
            deepseek: [],
            grok: [],
            gpt: [],
            minimax: [],
            doubao: [],
            qwen: [],
            other: []
        };

        // 分类模型 - 保持不变
        filteredModels.forEach(model => {
            const modelId = model.id.toLowerCase();
            
            if (modelId.includes('gemini')) {
                categories.gemini.push(model);
            } else if (modelId.includes('claude')) {
                categories.claude.push(model);
            } else if (modelId.includes('deepseek')) {
                categories.deepseek.push(model);
            } else if (modelId.includes('grok')) {
                categories.grok.push(model);
            } else if (modelId.includes('gpt') || modelId.includes('o3') || 
                       modelId.includes('o4') || modelId.includes('o5')) {
                categories.gpt.push(model);
            } else if (modelId.includes('minimax')) {
                categories.minimax.push(model);
            } else if (modelId.includes('doubao')) {
                categories.doubao.push(model);
            } else if (modelId.includes('qwen')) {
                categories.qwen.push(model);
            } else {
                categories.other.push(model);
            }
        });

        // 创建最终分类对象，只包含非空分类
        const finalCategories = {};
        const categoryOrder = ['gemini', 'claude', 'deepseek', 'grok', 'gpt', 'minimax', 'doubao', 'qwen', 'other'];
        
        categoryOrder.forEach(category => {
            if (categories[category].length > 0) {
                finalCategories[category] = categories[category];
            }
        });

        return finalCategories;
    }

    /* 添加备用分类函数 - 当过滤条件太严格时使用 */
    function categorizeAllModels(models) {
        // 简单分类，只按其他分类
        return {
            other: models
        };
    }

    /* 创建模型选择UI */
    function createModelSelectorUI(models, onModelSelect) {
        const categorizedModels = filterAndCategorizeModels(models);
        const categories = Object.keys(categorizedModels);
        
        if (categories.length === 0) {
            return parent$('<div class="model-selector-empty">未找到可用的模型</div>');
        }
        
        const $selector = parent$(`
            <div class="model-selector-container">
                <div class="model-selector-header">
                    <input type="text" class="model-search-input" placeholder="搜索模型...">
                </div>
                <div class="model-categories-tabs"></div>
                <div class="model-list-panels"></div>
            </div>
        `);
        
        const $tabs = $selector.find('.model-categories-tabs');
        const $panels = $selector.find('.model-list-panels');
        
        // 创建分类标签和面板
        categories.forEach((category, index) => {
            const displayName = category.charAt(0).toUpperCase() + category.slice(1);
            const isActive = index === 0 ? 'active' : '';
            
            $tabs.append(`<div class="model-category-tab ${isActive}" data-category="${category}">${displayName}</div>`);
            
            const $panel = parent$(`<div class="model-list-panel ${isActive}" data-category="${category}"></div>`);
            categorizedModels[category].forEach(model => {
                $panel.append(`<div class="model-list-item" data-model-id="${model.id}">${model.id}</div>`);
            });
            
            $panels.append($panel);
        });
        
        // 绑定分类标签点击事件
        $selector.on('click', '.model-category-tab', function() {
            const category = parent$(this).data('category');
            
            // 更新标签和面板激活状态
            $selector.find('.model-category-tab').removeClass('active');
            $selector.find('.model-list-panel').removeClass('active');
            
            parent$(this).addClass('active');
            $selector.find(`.model-list-panel[data-category="${category}"]`).addClass('active');
        });
        
        // 修改搜索框事件处理逻辑
        $selector.find('.model-search-input').on('input', function() {
            const searchText = parent$(this).val().toLowerCase();
            
            if (searchText === '') {
                // 恢复原始分类显示 - 修复清空搜索时的显示
                $selector.find('.model-categories-tabs').empty();
                $selector.find('.model-list-panels').empty();
                
                // 重建原始分类标签和面板
                categories.forEach((category, index) => {
                    const displayName = category.charAt(0).toUpperCase() + category.slice(1);
                    const isActive = index === 0 ? 'active' : '';
                    
                    $tabs.append(`<div class="model-category-tab ${isActive}" data-category="${category}">${displayName}</div>`);
                    
                    const $panel = parent$(`<div class="model-list-panel ${isActive}" data-category="${category}"></div>`);
                    categorizedModels[category].forEach(model => {
                        $panel.append(`<div class="model-list-item" data-model-id="${model.id}">${model.id}</div>`);
                    });
                    
                    $panels.append($panel);
                });
                
                // 移除搜索结果面板
                $selector.find('.model-list-panel[data-category="search-results"]').remove();
                return;
            }
            
            // 创建搜索结果面板（如果不存在）
            let $searchResultPanel = $selector.find('.model-list-panel[data-category="search-results"]');
            if ($searchResultPanel.length === 0) {
                $searchResultPanel = parent$('<div class="model-list-panel active" data-category="search-results"></div>');
                $selector.find('.model-list-panels').append($searchResultPanel);
                
                // 创建对应的标签
                const $searchTab = parent$('<div class="model-category-tab active" data-category="search-results">搜索结果</div>');
                $selector.find('.model-categories-tabs').empty().append($searchTab);
            }
            
            // 清空搜索结果面板
            $searchResultPanel.empty();
            
            // 收集所有匹配的模型并添加到搜索结果面板
            let matchFound = false;
            
            $selector.find('.model-list-panel:not([data-category="search-results"])').each(function() {
                const $panel = parent$(this);
                $panel.find('.model-list-item').each(function() {
                    const $item = parent$(this);
                    const modelId = $item.data('model-id').toLowerCase();
                    
                    if (modelId.includes(searchText)) {
                        matchFound = true;
                        // 克隆匹配项并添加到搜索结果
                        const $clonedItem = $item.clone(true);
                        $searchResultPanel.append($clonedItem);
                    }
                });
            });
            
            // 如果没有找到匹配项
            if (!matchFound) {
                $searchResultPanel.append('<div class="model-list-item no-results">无匹配结果</div>');
            }
            
            // 隐藏原始分类面板，仅显示搜索结果面板
            $selector.find('.model-list-panel:not([data-category="search-results"])').removeClass('active').hide();
            $searchResultPanel.addClass('active').show();
        });
        
        // 绑定模型项点击事件
        $selector.on('click', '.model-list-item', function() {
            const modelId = parent$(this).data('model-id');
            if (typeof onModelSelect === 'function') {
                onModelSelect(modelId);
            }
        });
        
        return $selector;
    }

    /* 显示模型选择对话框 */
    function showModelSelectorDialog(models, onSelect) {
        // 移除可能已存在的对话框
        parent$('#model-selector-dialog').remove();
        
        const $dialog = parent$(`
            <div id="model-selector-dialog">
                <div class="model-selector-dialog-content">
                    <div class="model-selector-dialog-header">
                        <h4>选择模型</h4>
                        <button class="model-selector-close-btn">×</button>
                    </div>
                    <div class="model-selector-dialog-body"></div>
                </div>
            </div>
        `);
        
        const $selector = createModelSelectorUI(models, (modelId) => {
            onSelect(modelId);
            $dialog.remove();
        });
        
        $dialog.find('.model-selector-dialog-body').append($selector);
        
        // 绑定关闭按钮事件
        $dialog.find('.model-selector-close-btn').on('click', () => {
            $dialog.remove();
        });
        
        // 点击对话框外部关闭
        $dialog.on('click', function(e) {
            if (e.target === this) {
                $dialog.remove();
            }
        });
        
        parent$('body').append($dialog);
    }

    /* 修改样式，添加模型获取按钮和下拉菜单的样式 */
    function injectStyles() {
        if (parent$(`#${STYLE_ID}`).length > 0) return;
        const styles = `
            <style id="${STYLE_ID}">
                #${BUTTON_ID} { margin-left: 10px; color: #ccc; cursor: pointer; transition: color 0.2s, transform 0.2s; display: inline-block; vertical-align: middle; }
                #${BUTTON_ID}:hover { color: #00aaff; transform: scale(1.1); }
                #${OVERLAY_ID}{position:fixed;top:0;left:0;width:100%;height:100vh;background-color:rgba(0,0,0,.7);z-index:9999;display:none;justify-content:center;align-items:center;pointer-events:auto}
                #${PANEL_ID}{display:flex;flex-direction:column;width:90%;max-width:700px;height:80vh;max-height:800px;background-color:#181818;color:#fff;border:1px solid #444;border-radius:8px;box-shadow:0 4px 25px rgba(0,0,0,.3);pointer-events:auto;z-index:10000;margin-top:-40px;}
                #${PANEL_ID} .panel-header{padding:15px;border-bottom:1px solid #444;display:flex;justify-content:space-between;align-items:center}
                #${PANEL_ID} .panel-header h4{margin:0;font-size:1.2em}
                #${PANEL_ID} .panel-header .encryption-status{font-size:0.8em;color:#888;margin-left:10px;}
                #${PANEL_ID} .panel-close-btn{background:0 0;border:none;color:#fff;font-size:20px;cursor:pointer;opacity:.7;transition:opacity .2s}
                #${PANEL_ID} .panel-close-btn:hover{opacity:1}
                #${PANEL_ID} .panel-content{flex:1;min-height:0;overflow-y:auto;padding:20px; display:flex; flex-direction:column; gap: 20px;}
                #${PANEL_ID} input[type=text]{width:100%;background-color:#101010;color:#fff;border:1px solid #444;border-radius:4px;padding:8px;box-sizing:border-box}
                #${PANEL_ID} .menu_button{width:auto;flex-shrink:0}
                .acm-section { border: 1px solid #333; border-radius: 6px; padding: 15px; margin-bottom:0; }
                .profile-actions { display: flex; gap: 10px; margin-bottom: 15px; }
                .profile-tabs-container { display: flex; overflow-x: auto; white-space: nowrap; padding-bottom: 10px; gap: 8px; border-bottom: none; margin-bottom: 0; scrollbar-width: thin; scrollbar-color: #444 #222; }
                .profile-tabs-container::-webkit-scrollbar { height: 5px; }
                .profile-tabs-container::-webkit-scrollbar-thumb { background: #444; border-radius: 5px; }
                .profile-tab { padding: 6px 12px; border: 1px solid #444; border-radius: 20px; cursor: grab; transition: all 0.2s; font-size: 0.9em; white-space:nowrap; text-overflow:ellipsis; overflow:hidden; max-width: none; text-overflow: unset; overflow: visible; }
                .profile-tab:hover { background-color: #333; border-color: #555; }
                .profile-tab.active { background-color: #007bff; border-color: #007bff; color: white; font-weight: bold; }
                .profile-tab.over { border-style: dashed; border-color: #007bff; }
                .profile-tab.dragging { opacity: 0.5; cursor: grabbing; }
                .config-units-container { flex: 1; min-height: 0; overflow-y: auto; max-height: calc(100% - 100px); }
                #${PANEL_ID} .form-group { display: flex; flex-direction: row; align-items: center; margin-bottom: 15px; width: 100%; flex-wrap: nowrap; }
                #${PANEL_ID} label { width: 90px; min-width: 90px; margin-bottom: 0; margin-right: 10px; color: #ccc; font-size: 0.9em; flex-shrink: 0; }
                #${PANEL_ID} input[type=text] { flex: 1 1 auto; width: auto; min-width: 0; margin-left: 0; }
                #${PANEL_ID} .keys-container, #${PANEL_ID} .models-container { flex: 1 1 auto; width: auto; min-width: 0; padding: 0; margin: 0; }
                #${PANEL_ID} .key-row, #${PANEL_ID} .model-row { width: 100%; display: flex; box-sizing: border-box; }
                .key-row { display: flex; gap: 5px; align-items: center; margin-bottom: 8px; width: 100%; position: relative; }
                .key-row input.config-key { flex: 1; border-top-right-radius: 0; border-bottom-right-radius: 0; }
                .api-keys-dropdown-btn { padding: 8px 12px; margin-left: auto; }
                .api-key-dropdown { position: absolute; top: 100%; right: 0; width: 200px; background-color: #222; border: 1px solid #444; border-radius: 4px; z-index: 10; max-height: 200px; overflow-y: auto; box-shadow: 0 2px 10px rgba(0,0,0,0.3); }
                .api-key-item { padding: 8px 12px; cursor: pointer; transition: background-color 0.2s; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
                .api-key-item:hover { background-color: #333; }
                .api-key-item.active { background-color: #2a2a2a; font-weight: bold; }
                .api-key-item.add-new-api { border-top: 1px solid #444; color: #007bff; }
                .key-row.highlight .config-key { border-color: #007bff; box-shadow: 0 0 0 2px rgba(0,123,255,0.25); transition: border-color .15s ease-in-out, box-shadow .15s ease-in-out; }
                .model-row { display: flex; gap: 5px; align-items: center; margin-bottom: 8px; width: 100%; }
                .model-row input { flex: 1 1 auto; min-width: 0; }
                .model-actions { display: flex; gap: 5px; flex: 0 0 auto; margin-left: auto; }
                .model-actions .menu_button { width: 30px; height: 30px; display: flex; align-items: center; justify-content: center; }
                .delete-key-btn { margin-left: auto; color: #ff5555; cursor: pointer; opacity: 0.7; transition: opacity 0.2s; display: inline-block; float: right; }
                .api-key-item:hover .delete-key-btn { display: inline-block; }
                .delete-key-btn:hover { opacity: 1; }
                .fetch-models-btn { display: inline-block; margin-left: 5px; cursor: pointer; color: #999; transition: color 0.2s, transform 0.2s; font-size: 0.9em; }
                .fetch-models-btn:hover { color: #007bff; transform: scale(1.1); }
                .fetch-models-btn.loading { animation: spin 1s linear infinite; }
                .model-list-dropdown { position: absolute; top: 100%; left: 100px; width: calc(100% - 100px); background-color: #222; border: 1px solid #444; border-radius: 4px; z-index: 10; max-height: 300px; overflow-y: auto; box-shadow: 0 2px 10px rgba(0,0,0,0.3); }
                .model-list-item { padding: 8px 12px; cursor: pointer; transition: background-color 0.2s; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
                .model-list-item:hover { background-color: #333; }
                .model-list-item.no-models { color: #ff5555; cursor: default; }
                @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
                @media (max-width: 600px) {
                    #${PANEL_ID} .form-group { flex-direction: column; align-items: flex-start; }
                    #${PANEL_ID} label { width: 100%; margin-bottom: 5px; margin-right: 0; }
                    #${PANEL_ID} .form-group > input[type=text] { width: 100%; margin-left: 0; }
                    #${PANEL_ID} .keys-container, #${PANEL_ID} .models-container { width: 100%; margin-left: 0; }
                    #${PANEL_ID} .key-row input.config-key, #${PANEL_ID} .model-row input.config-model { width: auto; flex: 1 1 auto; }
                    .model-list-dropdown { left: 0; width: 100%; }
                }

                /* 模型选择器对话框样式 */
                #model-selector-dialog {
                    position: fixed;
                    top: 0;
                    left: 0;
                    width: 100%;
                    height: 100vh;
                    background-color: rgba(0, 0, 0, 0.7);
                    z-index: 10001;
                    display: flex;
                    justify-content: center;
                    align-items: center;
                }
                .model-selector-dialog-content {
                    width: 90%;
                    max-width: 600px;
                    max-height: 80vh;
                    background-color: #222;
                    border-radius: 8px;
                    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
                    display: flex;
                    flex-direction: column;
                    overflow: hidden;
                    margin-top: 0px; /* 由于已经居中，可以调整此值来微调位置 */
                }
                .model-selector-dialog-header {
                    padding: 12px 15px;
                    border-bottom: 1px solid #444;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                }
                .model-selector-dialog-header h4 {
                    margin: 0;
                    color: #fff;
                }
                .model-selector-close-btn {
                    background: none;
                    border: none;
                    color: #ccc;
                    font-size: 24px;
                    cursor: pointer;
                }
                .model-selector-dialog-body {
                    flex: 1;
                    overflow-y: auto;
                    padding: 0;
                }
                
                /* 模型选择器内部样式 */
                .model-selector-container {
                    display: flex;
                    flex-direction: column;
                    height: 100%;
                    max-height: 60vh;
                }
                .model-selector-header {
                    position: relative;
                    padding: 15px;
                    border-bottom: 1px solid #333;
                }
                .model-search-input {
                    width: 100%;
                    padding: 8px 12px;
                    border-radius: 4px;
                    border: 1px solid #444;
                    background-color: #181818;
                    color: #fff;
                    font-size: 14px;
                }
                .model-categories-tabs {
                    display: flex;
                    overflow-x: auto;
                    border-bottom: 1px solid #333;
                    padding: 0 5px;
                    scrollbar-width: thin;
                    scrollbar-color: #444 #222;
                }
                .model-categories-tabs::-webkit-scrollbar {
                    height: 5px;
                }
                .model-categories-tabs::-webkit-scrollbar-thumb {
                    background: #444;
                    border-radius: 5px;
                }
                .model-category-tab {
                    padding: 8px 15px;
                    margin: 5px 5px 0;
                    border-radius: 4px 4px 0 0;
                    cursor: pointer;
                    color: #ccc;
                    white-space: nowrap;
                    background-color: #333;
                    border: 1px solid #444;
                    border-bottom: none;
                }
                .model-category-tab.active {
                    background-color: #007bff;
                    color: #fff;
                    border-color: #007bff;
                }
                .model-list-panels {
                    flex: 1;
                    overflow-y: auto;
                    position: relative;
                }
                .model-list-panel {
                    position: relative;  /* 改为相对定位，而不是绝对定位 */
                    width: 100%;
                    padding: 10px;
                    display: none;
                    overflow-y: auto;
                    max-height: 300px;
                }
                .model-list-panel.active {
                    display: block;
                }
                .model-list-item {
                    padding: 8px 12px;
                    margin: 5px 0;
                    cursor: pointer;
                    border-radius: 4px;
                    background-color: #2a2a2a;
                    transition: background-color 0.2s;
                }
                .model-list-item:hover {
                    background-color: #333;
                    color: #007bff;
                }
                .model-selector-empty {
                    padding: 20px;
                    text-align: center;
                    color: #ff5555;
                }
                
                @media (max-width: 600px) {
                    #${PANEL_ID} .form-group { flex-direction: column; align-items: flex-start; }
                    #${PANEL_ID} label { width: 100%; margin-bottom: 5px; margin-right: 0; }
                    #${PANEL_ID} .form-group > input[type=text] { width: 100%; margin-left: 0; }
                    #${PANEL_ID} .keys-container, #${PANEL_ID} .models-container { width: 100%; margin-left: 0; }
                    #${PANEL_ID} .key-row input.config-key, #${PANEL_ID} .model-row input.config-model { width: auto; flex: 1 1 auto; }
                    .model-list-dropdown { left: 0; width: 100%; }
                    .model-selector-dialog-content {
                        width: 95%;
                        max-height: 85vh;
                    }
                }

                /* 搜索结果下拉框样式 */
                .search-results-dropdown {
                    max-height: 50vh; /* 改为视窗高度的50%，更合理的高度 */
                    overflow-y: auto;
                    background-color: #222;
                    border: 1px solid #444;
                    border-radius: 0 0 4px 4px;
                    z-index: 100;
                    width: 100%;
                    position: absolute;
                    top: 100%;
                    left: 0;
                    box-shadow: 0 4px 10px rgba(0, 0, 0, 0.3);
                    padding: 5px 0;
                }

                /* 确保搜索结果在模态框内不被截断 */
                .model-selector-dialog-content {
                    overflow: visible; /* 允许内容溢出 */
                }

                .model-selector-header {
                    position: relative;
                    z-index: 10; /* 确保搜索框和结果在最上层 */
                }

                /* 确保搜索结果项有足够间距和可点击区域 */
                .search-results-dropdown .model-list-item {
                    padding: 10px 12px; /* 稍微增加内边距提高可点击性 */
                    margin: 3px 5px;
                }
            </style>`;
        parent$(parentDoc.head).append(styles);
    }

    function createAndInjectUI() {
        if (parent$(`#${OVERLAY_ID}`).length === 0) {
            const $overlay = parent$('<div/>', { id: OVERLAY_ID });
            const $panel = parent$(`
                <div id="${PANEL_ID}">
                    <div class="panel-header">
                        <h4>${SCRIPT_NAME}</h4>
                        <button class="panel-close-btn">×</button>
                    </div>
                    <div class="panel-content">
                        <div class="acm-section">
                            <div class="profile-actions">
                                <button class="menu_button add-profile-btn">添加新配置</button>
                                <button class="menu_button menu_button_bad delete-profile-btn">删除当前配置</button>
                            </div>
                            <div class="profile-tabs-container"></div>
                        </div>
                        <div class="config-units-container acm-section"></div>
                    </div>
                </div>`);
            $overlay.append($panel).appendTo(parent$('body'));
        }
    }
    
    function initDragAndDrop() {
        let dragSrcEl = null;
        function handleDragStart(e) { dragSrcEl = this; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', this.getAttribute('data-index')); this.classList.add('dragging'); }
        function handleDragOver(e) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; return false; }
        function handleDragEnter() { this.classList.add('over'); }
        function handleDragLeave() { this.classList.remove('over'); }
        async function handleDrop(e) {
            if (e.stopPropagation) e.stopPropagation();
            if (dragSrcEl !== this) {
                const srcIndex = parseInt(e.dataTransfer.getData('text/plain'));
                const destIndex = parseInt(this.getAttribute('data-index'));
                
                if (!isNaN(srcIndex) && !isNaN(destIndex) && settings.profiles) {
                    await saveCurrentProfileData();
                    const movedProfile = settings.profiles.splice(srcIndex, 1)[0];
                    settings.profiles.splice(destIndex, 0, movedProfile);
                    
                    await _saveSettingsDirectly();

                    renderProfileTabs(destIndex);
                    renderConfigUnits();
                }
            }
            return false;
        }
        function handleDragEnd() { parent$(`#${PANEL_ID} .profile-tab`).removeClass('dragging over'); }
        parent$(`#${PANEL_ID} .profile-tab`).each(function () { this.addEventListener('dragstart', handleDragStart, false); this.addEventListener('dragenter', handleDragEnter, false); this.addEventListener('dragover', handleDragOver, false); this.addEventListener('dragleave', handleDragLeave, false); this.addEventListener('drop', handleDrop, false); this.addEventListener('dragend', handleDragEnd, false); });
    }
    
    function bindEvents() {
        // 先解绑旧事件
        parent$('body').off('click', `#${BUTTON_ID}`);
        parent$('body').off('click', `#${PANEL_ID} .panel-close-btn`);
        parent$(parentDoc).off('click', `#${OVERLAY_ID}`);
        parent$('body').off('click', `#${PANEL_ID} .add-profile-btn`);
        parent$('body').off('click', `#${PANEL_ID} .delete-profile-btn`);
        parent$('body').off('click', `#${PANEL_ID} .profile-tab`);
        parent$('body').off('click', `#${PANEL_ID} .api-keys-dropdown-btn`);
        parent$('body').off('click', `#${PANEL_ID} .api-key-item`);
        parent$('body').off('click', `#${PANEL_ID} .delete-key-btn`);
        parent$('body').off('click', `#${PANEL_ID} .add-model-btn`);
        parent$('body').off('click', `#${PANEL_ID} .remove-model-btn`);
        parent$('body').off('click', `#${PANEL_ID} .apply-model-btn`);
        parent$('body').off('change', `#${PANEL_ID} .config-name, #${PANEL_ID} .config-endpoint, #${PANEL_ID} .config-model`);
        parent$('body').off('input', `#${PANEL_ID} .config-key`);
        parent$('body').off('click', `#${PANEL_ID} .fetch-models-btn`);

        // 然后再绑定事件
        parent$('body').on('click', `#${BUTTON_ID}`, (event) => {
            event.preventDefault();
            event.stopPropagation();
            updatePanel();
            parent$(`#${OVERLAY_ID}`).css('display', 'flex');
        });
        async function closeAndSave() {
            const success = await saveSettings();
            parent$(`#${OVERLAY_ID}`).hide();
            if (success && typeof toastr !== 'undefined') {
                toastr.success(`${SCRIPT_NAME}: 配置已保存`);
            }
            const $apiStatusTop = parent$('#API-status-top');
            if ($apiStatusTop.length > 0 && $apiStatusTop.hasClass('closedIcon')) {
                $apiStatusTop.trigger('click');
            }
        }
        parent$(parentDoc).on('click', `#${OVERLAY_ID}`, function (e) { if (e.target.id === OVERLAY_ID) closeAndSave(); });
        parent$('body').on('click', `#${PANEL_ID} .panel-close-btn`, function(e) {
            e.stopPropagation(); // 阻止事件冒泡到overlay
            closeAndSave();
        });

        parent$('body').on('click', `#${PANEL_ID} .add-profile-btn`, async () => { 
            await saveCurrentProfileData(); 
            const newIndex = settings.profiles.length; 
            settings.profiles.push({ 
                name: `新配置`, // 修改：移除索引编号，保持简单名称
                keys: [''], 
                endpoint: "", 
                models:[''] 
            }); 
            renderProfileTabs(newIndex); 
            renderConfigUnits(); // 添加这行：确保新配置显示的是空白表单
            parent$(`#${PANEL_ID} .profile-tab[data-index="${newIndex}"]`).addClass('active'); // 替换trigger('click')避免重复渲染
        });
        
        parent$('body').on('click', `#${PANEL_ID} .delete-profile-btn`, async () => {
            if (settings.profiles.length <= 1) {
                if (typeof toastr !== 'undefined') toastr.warning('至少需要保留一个配置');
                return;
            }
            
            const $activeTab = parent$(`#${PANEL_ID} .profile-tab.active`);
            if ($activeTab.length === 0) return;
            
            const indexToDelete = parseInt($activeTab.data('index'));
            if (isNaN(indexToDelete) || indexToDelete < 0 || indexToDelete >= settings.profiles.length) {
                console.error(`${LOG_PREFIX} 无效的删除索引: ${indexToDelete}`);
                return;
            }
            
            const profileName = settings.profiles[indexToDelete]?.name || `配置 ${indexToDelete + 1}`;
            
            if (confirm(`确定要删除配置 "${profileName}" 吗？`)) {
                settings.profiles.splice(indexToDelete, 1);
                
                await _saveSettingsDirectly();

                const newActiveIndex = Math.min(indexToDelete, settings.profiles.length - 1);
                
                renderProfileTabs(newActiveIndex);
                renderConfigUnits();
            }
        });
        parent$('body').on('click', `#${PANEL_ID} .profile-tab`, async function () { const $clickedTab = parent$(this); if ($clickedTab.hasClass('active')) return; await saveCurrentProfileData(); parent$(`#${PANEL_ID} .profile-tab`).removeClass('active'); $clickedTab.addClass('active'); renderConfigUnits(); });

        parent$('body').on('click', `#${PANEL_ID} .api-keys-dropdown-btn`, function (e) {
            e.stopPropagation();
            const $keyRow = parent$(this).closest('.key-row');
            
            if ($keyRow.find('.api-key-dropdown').length > 0) {
                $keyRow.find('.api-key-dropdown').remove();
                return;
            }
            
            parent$('.api-key-dropdown').remove();
            
            const currentIndex = parseInt($keyRow.data('index'));
            const $activeTab = parent$(`#${PANEL_ID} .profile-tab.active`);
            const activeIndex = parseInt($activeTab.data('index'));
            if (isNaN(activeIndex) || !settings.profiles || activeIndex >= settings.profiles.length) return;
            
            const keys = settings.profiles[activeIndex].keys || [''];
            const $dropdown = createApiKeyDropdown(keys, currentIndex);
            $keyRow.append($dropdown);
            
            setTimeout(() => { 
                parent$(parentDoc).one('click', () => parent$('.api-key-dropdown').remove()); 
            }, 0);
        });

        parent$('body').on('click', `#${PANEL_ID} .api-key-item`, function (e) {
            if (parent$(e.target).closest('.delete-key-btn').length > 0) {
                return;
            }
            
            const $item = parent$(this);
            const $dropdown = $item.closest('.api-key-dropdown');
            const $keyRow = $item.closest('.key-row');
            const $activeTab = parent$(`#${PANEL_ID} .profile-tab.active`);
            const activeProfileIndex = parseInt($activeTab.data('index'));

            if ($item.hasClass('add-new-api')) {
                const newIndex = settings.profiles[activeProfileIndex].keys.length;
                settings.profiles[activeProfileIndex].keys.push('');
                
                $keyRow.data('index', newIndex);
                $keyRow.find('.config-key').val('').focus();
            } else {
                const selectedIndex = parseInt($item.data('index'));
                if (!isNaN(selectedIndex) && settings.profiles[activeProfileIndex].keys[selectedIndex] !== undefined) {
                    $keyRow.data('index', selectedIndex);
                    $keyRow.find('.config-key').val(settings.profiles[activeProfileIndex].keys[selectedIndex]).focus();
                    
                    $keyRow.addClass('highlight');
                    setTimeout(() => $keyRow.removeClass('highlight'), 1000);
                }
            }
            
            $dropdown.remove();
        });

        parent$('body').on('click', `#${PANEL_ID} .delete-key-btn`, function (e) {
            e.stopPropagation();
            
            const $deleteBtn = parent$(this);
            const keyIndex = parseInt($deleteBtn.data('index'));
            const $keyRow = $deleteBtn.closest('.key-row');
            const currentRowIndex = parseInt($keyRow.data('index'));
            const $activeTab = parent$(`#${PANEL_ID} .profile-tab.active`);
            const activeProfileIndex = parseInt($activeTab.data('index'));
            
            if (isNaN(keyIndex) || isNaN(activeProfileIndex) || !settings.profiles[activeProfileIndex].keys) {
                return;
            }
            
            if (confirm(`确定要删除秘钥 ${keyIndex + 1} 吗？`)) {
                settings.profiles[activeProfileIndex].keys.splice(keyIndex, 1);
                
                if (settings.profiles[activeProfileIndex].keys.length === 0) {
                    settings.profiles[activeProfileIndex].keys.push('');
                }
                
                if (keyIndex === currentRowIndex) {
                    $keyRow.data('index', 0);
                    $keyRow.find('.config-key').val(settings.profiles[activeProfileIndex].keys[0]);
                } else if (keyIndex < currentRowIndex) {
                    $keyRow.data('index', currentRowIndex - 1);
                }
                
                parent$('.api-key-dropdown').remove();
                const keys = settings.profiles[activeProfileIndex].keys || [''];
                const newIndex = $keyRow.data('index');
                const $dropdown = createApiKeyDropdown(keys, newIndex);
                $keyRow.append($dropdown);
            }
        });

        parent$('body').on('click', `#${PANEL_ID} .add-model-btn`, function () {
            const $modelsContainer = parent$(this).closest('.models-container');
            addModelInput($modelsContainer, '');
        });

        parent$('body').on('click', `#${PANEL_ID} .remove-model-btn`, function () {
            const $modelRow = parent$(this).closest('.model-row');
            const $container = $modelRow.closest('.models-container');
            if ($container.find('.model-row').length > 1) {
                $modelRow.remove();
                updateModelRemoveButtons($container);
            }
        });
        
        parent$('body').on('click', `#${PANEL_ID} .apply-model-btn`, function() {
            const modelName = parent$(this).closest('.model-row').find('.config-model').val();
            if (modelName && typeof toastr !== 'undefined') {
                toastr.info(`模型 "${modelName}" 已选择`);
            }
        });

        parent$('body').on('change', `#${PANEL_ID} .config-name, #${PANEL_ID} .config-endpoint, #${PANEL_ID} .config-model`, async () => {
            await saveCurrentProfileData();
        });

        parent$('body').on('input', `#${PANEL_ID} .config-key`, function() {
            const $input = parent$(this);
            const $keyRow = $input.closest('.key-row');
            const keyIndex = parseInt($keyRow.data('index'));
            const $activeTab = parent$(`#${PANEL_ID} .profile-tab.active`);
            const activeProfileIndex = parseInt($activeTab.data('index'));
            
            if (!isNaN(keyIndex) && !isNaN(activeProfileIndex) && settings.profiles[activeProfileIndex] && settings.profiles[activeProfileIndex].keys) {
                settings.profiles[activeProfileIndex].keys[keyIndex] = $input.val();
            }
        });

        parent$('body').on('click', `#${PANEL_ID} .fetch-models-btn`, async function(e) {
            e.stopPropagation();
            
            // 获取当前配置信息
            const $activeTab = parent$(`#${PANEL_ID} .profile-tab.active`);
            const activeIndex = parseInt($activeTab.data('index'));
            if (isNaN(activeIndex) || !settings.profiles || activeIndex >= settings.profiles.length) {
                if (typeof toastr !== 'undefined') toastr.error('无法获取当前配置信息');
                return;
            }
            
            const currentProfile = settings.profiles[activeIndex];
            const endpoint = currentProfile.endpoint?.trim();
            const keyIndex = parseInt(parent$(`.key-row`).data('index')) || 0;
            const apiKey = currentProfile.keys[keyIndex]?.trim();
            
            if (!endpoint) {
                if (typeof toastr !== 'undefined') toastr.warning('请先填写API接口地址');
                return;
            }
            
            if (!apiKey) {
                if (typeof toastr !== 'undefined') toastr.warning('请先填写API秘钥');
                return;
            }
            
            // 显示加载状态
            const $fetchBtn = parent$(this);
            $fetchBtn.addClass('loading');
            
            try {
                // 获取模型列表
                const models = await fetchModelsList(endpoint, apiKey);
                
                if (models.length === 0) {
                    if (typeof toastr !== 'undefined') {
                        toastr.warning('未找到可用的模型');
                    }
                    return;
                }
                
                // 显示模型选择对话框
                showModelSelectorDialog(models, (modelId) => {
                    const $modelsContainer = parent$(this).closest('.form-group').find('.models-container');
                    addModelInput($modelsContainer, modelId);
                    updateModelRemoveButtons($modelsContainer);
                    
                    if (typeof toastr !== 'undefined') {
                        toastr.success(`已添加模型: ${modelId}`);
                    }
                });
            } catch (error) {
                if (typeof toastr !== 'undefined') {
                    toastr.error(`获取模型列表失败: ${error.message}`);
                }
            } finally {
                $fetchBtn.removeClass('loading');
            }
        });
    }

    // --- 初始化 ---
    async function init() {
        if (!parent$) return;

        logMessage("初始化开始...");
        try {
            cleanupOldUI();
            
            await runMigrationIfNeeded();
            
            await loadSettings();

            injectStyles();
            createAndInjectUI();
            bindEvents();

            const $apiConfigTitle = parent$('h3:contains("API连接配置")');
            if ($apiConfigTitle.length > 0 && parent$(`#${BUTTON_ID}`).length === 0) {
                const $button = parent$(`<a id="${BUTTON_ID}" href="#" title="${SCRIPT_NAME}"><i class="fa-solid fa-key"></i></a>`);
                $apiConfigTitle.append($button);
                logMessage("触发按钮已成功注入。");
            } else {
                 if (parent$(`#${BUTTON_ID}`).length > 0) {
                    logMessage("触发按钮已存在。");
                 } else {
                    logMessage("未找到'API连接配置'标题，无法注入触发按钮。", 'warn');
                 }
            }
            
            logMessage("初始化完成。");
            
            // 注入扩展菜单区域的按钮
            setTimeout(() => {
                try {
                    const $extensionsMenu = parent$('#extensionsMenu');
                    if ($extensionsMenu.length > 0 && parent$(`#${BUTTON_ID}-ext`).length === 0) {
                        const $extensionButton = parent$(`<a id="${BUTTON_ID}-ext" class="list-group-item" href="#" title="${SCRIPT_NAME}">
                            <i class="fa-solid fa-key"></i> ${SCRIPT_NAME}
                        </a>`);
                        
                        $extensionButton.on('click', function(event) {
                            event.preventDefault();
                            event.stopPropagation();
                            updatePanel();
                            parent$(`#${OVERLAY_ID}`).css('display', 'flex');
                        });
                        
                        // 直接添加到extensionsMenu中
                        $extensionsMenu.append($extensionButton);
                        logMessage("扩展菜单按钮已成功注入。");
                    }
                } catch (error) {
                    logMessage(`注入扩展菜单按钮时发生错误: ${error.message}`, 'warn');
                }
            }, 3000); // 延迟注入，确保扩展菜单已加载
        } catch (error) {
            logMessage(`初始化过程中发生严重错误: ${error.message}`, 'error');
            console.error(error);
        }
    }
    
    if (typeof (window.parent.jQuery || window.parent.$) === 'function') {
        setTimeout(init, 2000);
    } else {
        console.error(`${LOG_PREFIX} 等待父窗口jQuery超时，脚本可能无法正常工作。`);
    }

})();
