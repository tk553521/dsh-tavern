window.__ModuleLoader__.load({
	id: "dsh-tavern",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let _deepseek_ai_dsh_client_runtime_client = require("@deepseek-ai/dsh-client-runtime/client");
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/store.ts
		/**
		* Tavern UI store: cross-remount viewing state for the tavern view entry.
		* Business data (characters, lorebooks, presets, plays) lives on the host and
		* is fetched per mount; only navigation and selection survive here.
		*/
		/**
		* Declares the tavern viewing state and write surface.
		* @returns the store handle.
		*/
		function createTavernStore() {
			return (0, _deepseek_ai_dsh_client_runtime_client.defineStore)({
				init: () => ({
					panel: "chat",
					playId: null,
					selectedCharacterId: null,
					selectedLorebookId: null,
					selectedPresetId: null,
					draft: {
						characterIds: [],
						lorebookIds: [],
						narratorEnabled: false
					},
					generating: false,
					error: null,
					replyMode: "first"
				}),
				actions: {
					setPanel: (d, panel) => {
						d.panel = panel;
					},
					setPlayId: (d, playId) => {
						d.playId = playId;
					},
					selectCharacter: (d, id) => {
						d.selectedCharacterId = id;
					},
					selectLorebook: (d, id) => {
						d.selectedLorebookId = id;
					},
					selectPreset: (d, id) => {
						d.selectedPresetId = id;
					},
					setDraft: (d, draft) => {
						d.draft = draft;
					},
					toggleDraftCharacter: (d, id) => {
						const has = d.draft.characterIds.includes(id);
						d.draft = {
							...d.draft,
							characterIds: has ? d.draft.characterIds.filter((cid) => cid !== id) : [...d.draft.characterIds, id]
						};
					},
					setDraftLorebooks: (d, lorebookIds) => {
						d.draft = {
							...d.draft,
							lorebookIds
						};
					},
					setDraftPreset: (d, presetId) => {
						d.draft = {
							...d.draft,
							presetId
						};
					},
					setDraftNarrator: (d, enabled) => {
						d.draft = {
							...d.draft,
							narratorEnabled: enabled
						};
					},
					setGenerating: (d, generating) => {
						d.generating = generating;
					},
					setError: (d, error) => {
						d.error = error;
					},
					setReplyMode: (d, mode) => {
						d.replyMode = mode;
					}
				}
			});
		}
		//#endregion
		//#region src/client/api.ts
		async function request(path, init) {
			const response = await fetch(path, {
				...init,
				headers: {
					...init?.body !== void 0 && typeof init.body === "string" ? { "content-type": "application/json" } : {},
					...init?.headers
				}
			});
			if (!response.ok) {
				let message = `请求失败：${response.status}`;
				try {
					const body = await response.json();
					if (body.error) message = body.error;
				} catch {}
				throw new Error(message);
			}
			return response.json();
		}
		function api() {
			return {
				state: () => request("/tavern/state"),
				createCharacter: (input) => request("/tavern/characters", {
					method: "POST",
					body: JSON.stringify(input)
				}),
				updateCharacter: (id, data, avatar) => request(`/tavern/characters/${encodeURIComponent(id)}`, {
					method: "PUT",
					body: JSON.stringify({
						data,
						avatar
					})
				}),
				deleteCharacter: async (id) => {
					await request(`/tavern/characters/${encodeURIComponent(id)}`, { method: "DELETE" });
				},
				exportCharacterUrl: (id) => `/tavern/characters/${encodeURIComponent(id)}/export`,
				createLorebook: (input) => request("/tavern/lorebooks", {
					method: "POST",
					body: JSON.stringify(input)
				}),
				updateLorebook: (id, book, name) => request(`/tavern/lorebooks/${encodeURIComponent(id)}`, {
					method: "PUT",
					body: JSON.stringify({
						book,
						name
					})
				}),
				deleteLorebook: async (id) => {
					await request(`/tavern/lorebooks/${encodeURIComponent(id)}`, { method: "DELETE" });
				},
				exportLorebookUrl: (id) => `/tavern/lorebooks/${encodeURIComponent(id)}/export`,
				createPreset: (input) => request("/tavern/presets", {
					method: "POST",
					body: JSON.stringify(input)
				}),
				updatePreset: (id, patch) => request(`/tavern/presets/${encodeURIComponent(id)}`, {
					method: "PUT",
					body: JSON.stringify(patch)
				}),
				deletePreset: async (id) => {
					await request(`/tavern/presets/${encodeURIComponent(id)}`, { method: "DELETE" });
				},
				exportPresetUrl: (id) => `/tavern/presets/${encodeURIComponent(id)}/export`,
				importTauriTavern: (input) => request("/tavern/import/tauritavern", {
					method: "POST",
					body: JSON.stringify(input)
				}),
				createPlay: (input) => request("/tavern/plays", {
					method: "POST",
					body: JSON.stringify(input)
				}),
				getPlay: (id) => request(`/tavern/plays/${encodeURIComponent(id)}`),
				activatePlay: (id) => request(`/tavern/plays/${encodeURIComponent(id)}/activate`, {
					method: "POST",
					body: "{}"
				}),
				updatePlay: (id, patch) => request(`/tavern/plays/${encodeURIComponent(id)}`, {
					method: "PUT",
					body: JSON.stringify(patch)
				}),
				deletePlay: async (id) => {
					await request(`/tavern/plays/${encodeURIComponent(id)}`, { method: "DELETE" });
				},
				setDefaultPreset: async (defaultPresetId) => {
					await request("/tavern/settings", {
						method: "PUT",
						body: JSON.stringify({ defaultPresetId: defaultPresetId ?? null })
					});
				},
				setStyle: async (style) => {
					await request("/tavern/settings", {
						method: "PUT",
						body: JSON.stringify({ style })
					});
				}
			};
		}
		/** Shared singleton handle for the API (stateless). */
		const tavernApi = api();
		/** Read a file as base64 data URL. */
		function fileToDataUrl(file) {
			return new Promise((resolve, reject) => {
				const reader = new FileReader();
				reader.onload = () => resolve(String(reader.result));
				reader.onerror = () => reject(reader.error ?? /* @__PURE__ */ new Error("读取文件失败"));
				reader.readAsDataURL(file);
			});
		}
		/** Read a text file. */
		function fileToText(file) {
			return new Promise((resolve, reject) => {
				const reader = new FileReader();
				reader.onload = () => resolve(String(reader.result));
				reader.onerror = () => reject(reader.error ?? /* @__PURE__ */ new Error("读取文件失败"));
				reader.readAsText(file);
			});
		}
		//#endregion
		//#region src/client/avatar.ts
		/** Resolve a stored avatar value to an `<img src>` URL. */
		function avatarSrc(avatar) {
			if (avatar === void 0 || avatar === "") return void 0;
			if (/^(?:data:|blob:|https?:)/i.test(avatar) || avatar.startsWith("/")) return avatar;
			const file = avatar.replace(/\\/g, "/").split("/").pop();
			return file === void 0 || file === "" ? avatar : `/tavern/avatars/${encodeURIComponent(file)}`;
		}
		//#endregion
		//#region \0dsh-css:F:\搞事情\dshplugins\sillytavern\dshtavern\src\client\TavernView.module.css.mjs
		const css = "._9TEB7a_view{--tv-bg:var(--dsw-alias-bg-base);--tv-nav-bg:var(--dsw-alias-bg-module-platform);--tv-surface-card:var(--dsw-alias-bg-layer-2);--tv-surface-input:var(--dsw-specific-input-major);--tv-sidebar-fill:var(--dsw-specific-sidebar-fill);--tv-bubble-user:var(--dsw-specific-bubble);--tv-border:var(--dsw-alias-border-l2);--tv-border-strong:var(--dsw-alias-border-l3);--tv-text:var(--dsw-alias-label-primary);--tv-text-secondary:var(--dsw-alias-label-secondary);--tv-text-tertiary:var(--dsw-alias-label-tertiary);--tv-text-caption:var(--dsw-alias-label-caption);--tv-hover:var(--dsw-alias-interactive-bg-hover);--tv-active:var(--dsw-alias-interactive-bg-active);--tv-btn-bg:var(--dsw-alias-button-elevated-fill);--tv-btn-bg-hover:var(--dsw-alias-interactive-bg-hover-solid);--tv-primary-fill:var(--dsw-alias-button-primary-fill);--tv-primary-fill-hover:var(--dsw-alias-button-primary-hover);--tv-primary-text:var(--dsw-alias-label-primary-foreground);--tv-danger-fill:color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent);--tv-danger-fill-hover:color-mix(in srgb, var(--dsw-alias-state-error-primary) 18%, transparent);--tv-danger-border:color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, transparent);--tv-error:var(--dsw-alias-state-error-primary);--tv-focus:var(--dsw-alias-state-business-primary);--tv-user-name:var(--dsw-alias-state-business-primary);--tv-accent:var(--dsw-static-amber-500);--tv-accent-text:var(--dsw-static-amber-600);--tv-accent-soft:color-mix(in srgb, var(--tv-accent) 12%, transparent);--tv-accent-border:color-mix(in srgb, var(--tv-accent) 32%, transparent);--tv-accent-border-strong:color-mix(in srgb, var(--tv-accent) 55%, transparent);background:radial-gradient(1200px 600px at 80% -10%, var(--tv-accent-soft), transparent 60%), var(--tv-bg);height:100%;min-height:0;color:var(--tv-text);font:var(--dsw-font-s-14);flex-direction:column;display:flex}._9TEB7a_nav{border-bottom:1px solid var(--tv-border);background:var(--tv-nav-bg);flex-shrink:0;align-items:center;gap:4px;padding:8px 12px;display:flex}._9TEB7a_navTitle{font:var(--dsw-font-m-18);letter-spacing:2px;color:var(--tv-accent-text);white-space:nowrap;margin-right:12px;font-weight:700}._9TEB7a_navTab{color:var(--tv-text-secondary);cursor:pointer;font:var(--dsw-font-xs-13);transition:background var(--ds-transition-duration) var(--ds-ease-in-out), color var(--ds-transition-duration) var(--ds-ease-in-out);background:0 0;border:none;border-radius:6px;padding:6px 14px}._9TEB7a_navTab:hover{background:var(--tv-hover);color:var(--tv-text)}._9TEB7a_navTabActive{background:var(--tv-accent-soft);color:var(--tv-accent-text);font-weight:600}._9TEB7a_navSpacer{flex:1}._9TEB7a_navError{color:var(--tv-error);font:var(--dsw-font-xxs-12);text-overflow:ellipsis;white-space:nowrap;max-width:40%;overflow:hidden}._9TEB7a_stylePicker{font:var(--dsw-font-xxs-12);color:var(--tv-text-tertiary);white-space:nowrap;align-items:center;gap:6px;margin-right:8px;display:inline-flex}._9TEB7a_styleSelect{background:var(--tv-surface-input);border:1px solid var(--tv-border);color:var(--tv-text-secondary);font:var(--dsw-font-xxs-12);cursor:pointer;transition:border-color var(--ds-transition-duration) var(--ds-ease-in-out), box-shadow var(--ds-transition-duration) var(--ds-ease-in-out);border-radius:6px;outline:none;padding:3px 8px;font-family:inherit}._9TEB7a_styleSelect:focus{border-color:var(--tv-focus);box-shadow:0 0 0 2px color-mix(in srgb, var(--tv-focus) 18%, transparent)}._9TEB7a_body{flex:1;min-height:0;display:flex}._9TEB7a_sidebar{border-right:1px solid var(--tv-border);background:var(--tv-sidebar-fill);flex-direction:column;flex-shrink:0;width:260px;min-height:0;display:flex}._9TEB7a_sidebarHead{border-bottom:1px solid var(--tv-border);flex-shrink:0;align-items:center;gap:8px;padding:10px 12px;display:flex}._9TEB7a_sidebarTitle{font:var(--dsw-font-xs-strong-13);color:var(--tv-accent-text);flex:1}._9TEB7a_list{flex-direction:column;flex:1;gap:4px;min-height:0;padding:6px;display:flex;overflow-y:auto}._9TEB7a_listItem{cursor:pointer;color:var(--tv-text);text-align:left;font:var(--dsw-font-xs-13);width:100%;transition:background var(--ds-transition-duration) var(--ds-ease-in-out);background:0 0;border:none;border-radius:6px;align-items:center;gap:8px;padding:7px 9px;display:flex}._9TEB7a_listItem:hover{background:var(--tv-hover)}._9TEB7a_listItemActive{background:var(--tv-accent-soft)}._9TEB7a_listItemAvatar{object-fit:cover;background:var(--tv-accent-soft);border-radius:50%;flex-shrink:0;width:30px;height:30px}._9TEB7a_listItemName{text-overflow:ellipsis;white-space:nowrap;flex:1;overflow:hidden}._9TEB7a_listItemMeta{font:var(--dsw-font-xxxs-11);color:var(--tv-text-caption)}._9TEB7a_empty{text-align:center;color:var(--tv-text-tertiary);font:var(--dsw-font-xs-13);padding:24px 12px}._9TEB7a_content{flex-direction:column;flex:1;gap:12px;min-width:0;min-height:0;padding:14px;display:flex;overflow-y:auto}._9TEB7a_grid{grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px;display:grid}._9TEB7a_card{border:1px solid var(--tv-border);background:var(--tv-surface-card);cursor:pointer;transition:border-color var(--ds-transition-duration) var(--ds-ease-in-out), transform var(--ds-transition-duration) var(--ds-ease-in-out), box-shadow var(--ds-transition-duration) var(--ds-ease-in-out);text-align:center;border-radius:8px;flex-direction:column;align-items:center;gap:6px;padding:10px;display:flex}._9TEB7a_card:hover{border-color:var(--tv-accent-border-strong);box-shadow:var(--dsw-shadow-lv1);transform:translateY(-1px)}._9TEB7a_cardAvatar{object-fit:cover;background:var(--tv-accent-soft);border-radius:50%;width:64px;height:64px}._9TEB7a_cardName{font:var(--dsw-font-xs-strong-13)}._9TEB7a_cardTags{font:var(--dsw-font-xxxs-11);color:var(--tv-text-tertiary);text-overflow:ellipsis;white-space:nowrap;max-width:100%;overflow:hidden}._9TEB7a_chat{flex-direction:column;flex:1;height:100%;min-height:0;display:flex}._9TEB7a_chatHead{border-bottom:1px solid var(--tv-border);flex-shrink:0;align-items:center;gap:10px;padding:8px 12px;display:flex}._9TEB7a_chatTitle{font:var(--dsw-font-m-18);font-weight:700}._9TEB7a_chatMeta{font:var(--dsw-font-xxs-12);color:var(--tv-text-caption)}._9TEB7a_messages{flex-direction:column;flex:1;gap:12px;min-height:0;padding:14px 16px;display:flex;overflow-y:auto}._9TEB7a_msg{flex-direction:column;gap:3px;max-width:85%;display:flex}._9TEB7a_msgUser{align-self:flex-end;align-items:flex-end}._9TEB7a_msgName{font:var(--dsw-font-xxs-strong-12);color:var(--tv-accent-text)}._9TEB7a_msgUser ._9TEB7a_msgName{color:var(--tv-user-name)}._9TEB7a_msgBubble{background:var(--tv-surface-card);border:1px solid var(--tv-border);white-space:pre-wrap;word-break:break-word;font:var(--dsw-font-base-16);border-radius:22px;padding:10px 16px}._9TEB7a_msgUser ._9TEB7a_msgBubble{background:var(--tv-bubble-user);border:none}._9TEB7a_msgNarrator ._9TEB7a_msgBubble{font:var(--dsw-font-s-14);color:var(--tv-text-secondary);background:0 0;border:none;padding:2px 4px;font-style:italic}._9TEB7a_msgNarrator ._9TEB7a_msgName{color:var(--tv-text-tertiary)}._9TEB7a_msgSystem ._9TEB7a_msgBubble{color:var(--tv-text-caption);font:var(--dsw-font-xxs-12);background:0 0;border:none;padding:2px 4px}._9TEB7a_msgTime{font:var(--dsw-font-xxxs-11);color:var(--tv-text-caption)}._9TEB7a_composer{border-top:1px solid var(--tv-border);background:var(--tv-nav-bg);flex-direction:column;flex-shrink:0;gap:8px;padding:10px 12px;display:flex}._9TEB7a_composerRow{align-items:center;gap:8px;display:flex}._9TEB7a_composerInput{resize:none;background:var(--tv-surface-input);border:1px solid var(--dsw-alias-border-l2-darkmode-thin);min-height:40px;max-height:120px;color:var(--tv-text);font:var(--dsw-font-s-14);transition:border-color var(--ds-transition-duration) var(--ds-ease-in-out), box-shadow var(--ds-transition-duration) var(--ds-ease-in-out);border-radius:10px;outline:none;flex:1;padding:9px 12px;font-family:inherit}._9TEB7a_composerInput:focus{border-color:var(--tv-focus);box-shadow:0 0 0 2px color-mix(in srgb, var(--tv-focus) 18%, transparent)}._9TEB7a_composerInput:disabled{opacity:.5}._9TEB7a_sendBtn{background:var(--tv-primary-fill);color:var(--tv-primary-text);cursor:pointer;height:40px;font-weight:600;font:var(--dsw-font-s-strong-14);transition:background var(--ds-transition-duration) var(--ds-ease-in-out);border:none;border-radius:10px;flex-shrink:0;padding:0 18px}._9TEB7a_sendBtn:hover:not(:disabled){background:var(--tv-primary-fill-hover)}._9TEB7a_sendBtn:disabled{opacity:.45;cursor:default}._9TEB7a_modeRow{font:var(--dsw-font-xxs-12);color:var(--tv-text-tertiary);align-items:center;gap:10px;display:flex}._9TEB7a_modeLabel{cursor:pointer;align-items:center;gap:4px;display:flex}._9TEB7a_btn{border:1px solid var(--tv-border);background:var(--tv-btn-bg);color:var(--tv-text-secondary);cursor:pointer;font:var(--dsw-font-xs-13);transition:background var(--ds-transition-duration) var(--ds-ease-in-out), color var(--ds-transition-duration) var(--ds-ease-in-out);white-space:nowrap;border-radius:6px;padding:5px 11px}._9TEB7a_btn:hover:not(:disabled){background:var(--tv-btn-bg-hover);color:var(--tv-text)}._9TEB7a_btn:disabled{opacity:.4;cursor:default}._9TEB7a_btnDanger{border-color:var(--tv-danger-border);background:var(--tv-danger-fill);color:var(--tv-error)}._9TEB7a_btnDanger:hover:not(:disabled){background:var(--tv-danger-fill-hover)}._9TEB7a_btnPrimary{background:var(--tv-primary-fill);color:var(--tv-primary-text);border-color:#0000;font-weight:600}._9TEB7a_btnPrimary:hover:not(:disabled){background:var(--tv-primary-fill-hover);color:var(--tv-primary-text)}._9TEB7a_btnGhost{color:var(--tv-text-tertiary);background:0 0;border-color:#0000;padding:4px 8px}._9TEB7a_btnGhost:hover:not(:disabled){background:var(--tv-hover);color:var(--tv-text-secondary)}._9TEB7a_field{flex-direction:column;gap:4px;display:flex}._9TEB7a_fieldLabel{font:var(--dsw-font-xxs-12);color:var(--tv-text-secondary)}._9TEB7a_fieldInput,._9TEB7a_fieldSelect,._9TEB7a_fieldTextarea{background:var(--tv-surface-input);border:1px solid var(--tv-border);color:var(--tv-text);font:var(--dsw-font-xs-13);transition:border-color var(--ds-transition-duration) var(--ds-ease-in-out), box-shadow var(--ds-transition-duration) var(--ds-ease-in-out);border-radius:6px;outline:none;padding:7px 10px;font-family:inherit}._9TEB7a_fieldInput:focus,._9TEB7a_fieldSelect:focus,._9TEB7a_fieldTextarea:focus{border-color:var(--tv-focus);box-shadow:0 0 0 2px color-mix(in srgb, var(--tv-focus) 18%, transparent)}._9TEB7a_fieldTextarea{resize:vertical;min-height:80px;line-height:1.5}._9TEB7a_row{flex-wrap:wrap;align-items:center;gap:8px;display:flex}._9TEB7a_spread{justify-content:space-between}._9TEB7a_hint{font:var(--dsw-font-xxs-12);color:var(--tv-text-tertiary);line-height:1.5}._9TEB7a_section{flex-direction:column;gap:10px;display:flex}._9TEB7a_sectionTitle{font:var(--dsw-font-xs-strong-13);color:var(--tv-accent-text);border-bottom:1px solid var(--tv-border);padding-bottom:6px}._9TEB7a_editor{flex-direction:column;gap:10px;max-width:720px;display:flex}._9TEB7a_badge{font:var(--dsw-font-xxxs-11);background:var(--tv-accent-soft);color:var(--tv-accent-text);border:1px solid var(--tv-accent-border);border-radius:10px;padding:1px 7px;display:inline-block}._9TEB7a_checkRow{font:var(--dsw-font-xs-13);cursor:pointer;align-items:center;gap:6px;display:flex}._9TEB7a_spinner{border:2px solid var(--tv-accent-border);border-top-color:var(--tv-accent);border-radius:50%;width:14px;height:14px;animation:.8s linear infinite _9TEB7a_spin;display:inline-block}@keyframes _9TEB7a_spin{to{transform:rotate(360deg)}}._9TEB7a_entryList{flex-direction:column;gap:6px;display:flex}._9TEB7a_entry{border:1px solid var(--tv-border);background:var(--tv-surface-card);border-radius:6px;flex-direction:column;gap:4px;padding:8px 10px;display:flex}._9TEB7a_entryKeys{font:var(--dsw-font-xxs-12);color:var(--tv-accent-text)}._9TEB7a_entryContent{font:var(--dsw-font-s-14);color:var(--tv-text-secondary);white-space:pre-wrap;max-height:120px;overflow-y:auto}._9TEB7a_entryHead{justify-content:space-between;align-items:center;gap:8px;display:flex}._9TEB7a_view :where(button,select):focus-visible{outline:1.5px solid var(--tv-focus);outline-offset:2px}._9TEB7a_view[data-style=classic]{color-scheme:dark;--tv-bg:#141210;--tv-nav-bg:#141210e6;--tv-surface-card:#00000047;--tv-surface-input:#00000059;--tv-sidebar-fill:#00000038;--tv-bubble-user:#8fb7d91f;--tv-border:#d4af3740;--tv-border-strong:#d4af3759;--tv-text:#e8e2d4;--tv-text-secondary:#c9bfa3;--tv-text-tertiary:#8d846c;--tv-text-caption:#8d846c;--tv-hover:#d4af371a;--tv-active:#d4af3733;--tv-btn-bg:#d4af371a;--tv-btn-bg-hover:#d4af3738;--tv-primary-fill:#b8962e;--tv-primary-fill-hover:#d4af37;--tv-primary-text:#201a08;--tv-danger-fill:#e06c5e14;--tv-danger-fill-hover:#e06c5e2e;--tv-danger-border:#e06c5e66;--tv-error:#e06c5e;--tv-focus:#d4af37;--tv-user-name:#8fb7d9;--tv-accent:#d4af37;--tv-accent-text:#d4af37;--tv-accent-soft:#d4af3726;--tv-accent-border:#d4af374d;--tv-accent-border-strong:#d4af37}._9TEB7a_playAvatarStack{flex-shrink:0;align-items:center;display:flex}._9TEB7a_playAvatarStack>*+*{margin-left:-8px}._9TEB7a_playAvatar{object-fit:cover;background:var(--tv-accent-soft);width:26px;height:26px;color:var(--tv-accent-text);border:2px solid var(--tv-sidebar-fill);font:var(--dsw-font-xxxs-11);border-radius:50%;justify-content:center;align-items:center;display:flex;overflow:hidden}._9TEB7a_playAvatarMore{background:var(--tv-surface-card);min-width:26px;height:26px;color:var(--tv-text-secondary);border:1px solid var(--tv-border);font:var(--dsw-font-xxxs-11);box-sizing:border-box;border-radius:999px;justify-content:center;align-items:center;padding:0 5px;display:inline-flex}._9TEB7a_listItemBody{flex-direction:column;flex:1;gap:2px;min-width:0;display:flex}._9TEB7a_playTitle{font:var(--dsw-font-xs-strong-13);color:var(--tv-text);text-overflow:ellipsis;white-space:nowrap;max-width:100%;overflow:hidden}._9TEB7a_playMeta{font:var(--dsw-font-xxxs-11);color:var(--tv-text-secondary);text-overflow:ellipsis;white-space:nowrap;max-width:100%;overflow:hidden}._9TEB7a_createSheet{border:1px solid var(--tv-border);background:color-mix(in srgb, var(--tv-surface-card) 78%, transparent);width:100%;max-width:1080px;box-shadow:var(--dsw-shadow-lv1);border-radius:14px;flex-direction:column;gap:16px;margin:0 auto;padding:18px;display:flex}._9TEB7a_createHeader{justify-content:space-between;align-items:flex-start;gap:12px;display:flex}._9TEB7a_createHeaderText{flex-direction:column;gap:4px;min-width:0;display:flex}._9TEB7a_createTitle{font:var(--dsw-font-m-18);color:var(--tv-text);font-weight:700}._9TEB7a_createSubtitle{font:var(--dsw-font-xs-13);color:var(--tv-text-secondary);max-width:760px;line-height:1.6}._9TEB7a_castCount{border:1px solid var(--tv-accent-border);background:var(--tv-accent-soft);color:var(--tv-accent-text);font:var(--dsw-font-xxs-strong-12);white-space:nowrap;border-radius:999px;flex-shrink:0;padding:5px 10px}._9TEB7a_castCountEmpty{border-color:var(--tv-border);background:var(--tv-surface-input);color:var(--tv-text-tertiary)}._9TEB7a_createBasics{grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;display:grid}._9TEB7a_createModes{grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:10px;display:grid}._9TEB7a_modeCard{text-align:left;border:1px solid var(--tv-border);background:var(--tv-surface-input);color:var(--tv-text);cursor:pointer;transition:border-color var(--ds-transition-duration) var(--ds-ease-in-out), background var(--ds-transition-duration) var(--ds-ease-in-out), box-shadow var(--ds-transition-duration) var(--ds-ease-in-out);border-radius:10px;flex-direction:column;align-items:flex-start;gap:4px;padding:10px 12px;display:flex}._9TEB7a_modeCard:hover:not(:disabled){border-color:var(--tv-accent-border-strong)}._9TEB7a_modeCard:disabled{opacity:.5;cursor:default}._9TEB7a_modeCardOn{border-color:var(--tv-accent-border-strong);background:var(--tv-accent-soft);box-shadow:inset 0 0 0 1px var(--tv-accent-border)}._9TEB7a_modeCardTitle{font:var(--dsw-font-xs-strong-13);color:var(--tv-text)}._9TEB7a_modeCardOn ._9TEB7a_modeCardTitle{color:var(--tv-accent-text)}._9TEB7a_modeCardText{font:var(--dsw-font-xxs-12);color:var(--tv-text-tertiary);line-height:1.45}._9TEB7a_castPicker{border:1px solid var(--tv-border);background:color-mix(in srgb, var(--tv-surface-input) 55%, transparent);border-radius:12px;flex-direction:column;gap:10px;padding:12px;display:flex}._9TEB7a_castPickerHead{flex-wrap:wrap;justify-content:space-between;align-items:center;gap:10px;display:flex}._9TEB7a_castPickerTitleRow{flex-direction:column;gap:2px;display:flex}._9TEB7a_castPickerTitle{font:var(--dsw-font-s-strong-14);color:var(--tv-accent-text)}._9TEB7a_castPickerHint{font:var(--dsw-font-xxs-12);color:var(--tv-text-tertiary)}._9TEB7a_castPickerActions{align-items:center;gap:8px;display:flex}._9TEB7a_castSearch{background:var(--tv-surface-input);border:1px solid var(--tv-border);width:min(280px,100%);color:var(--tv-text);font:var(--dsw-font-xxs-12);transition:border-color var(--ds-transition-duration) var(--ds-ease-in-out), box-shadow var(--ds-transition-duration) var(--ds-ease-in-out);border-radius:999px;outline:none;padding:6px 12px;font-family:inherit}._9TEB7a_castSearch:focus{border-color:var(--tv-focus);box-shadow:0 0 0 2px color-mix(in srgb, var(--tv-focus) 18%, transparent)}._9TEB7a_castOrder{flex-wrap:wrap;align-items:center;gap:6px;display:flex}._9TEB7a_castOrderLabel{font:var(--dsw-font-xxs-12);color:var(--tv-text-tertiary);margin-right:2px}._9TEB7a_castOrderItem{border:1px solid var(--tv-border);background:var(--tv-surface-input);max-width:240px;color:var(--tv-text);cursor:pointer;transition:border-color var(--ds-transition-duration) var(--ds-ease-in-out), background var(--ds-transition-duration) var(--ds-ease-in-out);border-radius:999px;align-items:center;gap:6px;padding:4px 9px 4px 5px;display:inline-flex}._9TEB7a_castOrderItem:hover{border-color:var(--tv-accent-border-strong)}._9TEB7a_castOrderItemMain{border-color:var(--tv-accent-border-strong);background:var(--tv-accent-soft)}._9TEB7a_castOrderAvatar{object-fit:cover;background:var(--tv-accent-soft);width:20px;height:20px;color:var(--tv-accent-text);font:var(--dsw-font-xxxs-11);border-radius:50%;flex-shrink:0;justify-content:center;align-items:center;display:flex;overflow:hidden}._9TEB7a_castOrderName{font:var(--dsw-font-xxs-12);text-overflow:ellipsis;white-space:nowrap;overflow:hidden}._9TEB7a_castOrderRank{font:var(--dsw-font-xxxs-11);color:var(--tv-accent-text);white-space:nowrap;font-weight:700}._9TEB7a_castGrid{grid-template-columns:repeat(auto-fill,minmax(172px,1fr));gap:10px;max-height:420px;padding:2px;display:grid;overflow-y:auto}._9TEB7a_castCard{border:1px solid var(--tv-border);background:var(--tv-surface-card);min-width:0;color:var(--tv-text);text-align:left;cursor:pointer;transition:border-color var(--ds-transition-duration) var(--ds-ease-in-out), background var(--ds-transition-duration) var(--ds-ease-in-out), box-shadow var(--ds-transition-duration) var(--ds-ease-in-out), transform var(--ds-transition-duration) var(--ds-ease-in-out);border-radius:12px;flex-direction:column;gap:8px;padding:10px;display:flex;position:relative}._9TEB7a_castCard:hover{border-color:var(--tv-accent-border-strong);box-shadow:var(--dsw-shadow-lv1);transform:translateY(-2px)}._9TEB7a_castCardSelected{border-color:var(--tv-accent-border-strong);background:linear-gradient(180deg, color-mix(in srgb, var(--tv-accent) 14%, transparent), transparent 90px), var(--tv-surface-card);box-shadow:inset 0 0 0 1px var(--tv-accent-border)}._9TEB7a_castCardMedia{background:var(--tv-accent-soft);border-radius:10px;justify-content:center;align-items:center;width:100%;height:104px;display:flex;overflow:hidden}._9TEB7a_castCardAvatar{object-fit:cover;background:var(--tv-accent-soft);width:100%;height:100%;color:var(--tv-accent-text);border-radius:10px;justify-content:center;align-items:center;font-size:30px;font-weight:700;display:flex}._9TEB7a_castRank{border:1px solid var(--tv-border-strong);background:color-mix(in srgb, var(--tv-bg) 82%, transparent);color:var(--tv-text-secondary);font:var(--dsw-font-xxxs-11);pointer-events:none;border-radius:999px;padding:2px 8px;font-weight:700;position:absolute;top:16px;left:16px}._9TEB7a_castRankMain{border-color:var(--tv-accent-border-strong);background:var(--tv-accent);color:var(--tv-primary-text)}._9TEB7a_castCheck{border:1.5px solid var(--tv-border-strong);background:color-mix(in srgb, var(--tv-bg) 72%, transparent);width:24px;height:24px;color:var(--tv-primary-text);pointer-events:none;transition:border-color var(--ds-transition-duration) var(--ds-ease-in-out), background var(--ds-transition-duration) var(--ds-ease-in-out);border-radius:50%;justify-content:center;align-items:center;font-size:14px;font-weight:700;display:flex;position:absolute;top:16px;right:16px}._9TEB7a_castCardSelected ._9TEB7a_castCheck{border-color:var(--tv-accent-border-strong);background:var(--tv-accent)}._9TEB7a_castCardBody{flex-direction:column;gap:4px;min-width:0;display:flex}._9TEB7a_castCardName{font:var(--dsw-font-xs-strong-13);color:var(--tv-text);text-overflow:ellipsis;white-space:nowrap;overflow:hidden}._9TEB7a_castCardDesc{font:var(--dsw-font-xxs-12);color:var(--tv-text-secondary);-webkit-line-clamp:2;-webkit-box-orient:vertical;min-height:2.9em;line-height:1.45;display:-webkit-box;overflow:hidden}._9TEB7a_castCardTags{font:var(--dsw-font-xxxs-11);color:var(--tv-accent-text);text-overflow:ellipsis;white-space:nowrap;overflow:hidden}._9TEB7a_castEmpty{border:1px dashed var(--tv-border-strong);background:color-mix(in srgb, var(--tv-surface-input) 45%, transparent);text-align:center;border-radius:12px;flex-direction:column;justify-content:center;align-items:center;gap:6px;min-height:170px;padding:26px 16px;display:flex}._9TEB7a_castEmptyIcon{font-size:34px;line-height:1}._9TEB7a_castEmptyTitle{font:var(--dsw-font-xs-strong-13);color:var(--tv-text)}._9TEB7a_createFooter{flex-wrap:wrap;align-items:center;gap:12px;display:flex}._9TEB7a_createFooter>:first-child{min-width:140px}._9TEB7a_fieldInput,._9TEB7a_fieldSelect,._9TEB7a_fieldTextarea{box-sizing:border-box;width:100%}@media (width<=720px){._9TEB7a_createHeader{flex-direction:column}._9TEB7a_castPickerHead{flex-direction:column;align-items:flex-start}._9TEB7a_castSearch{width:100%}}._9TEB7a_lorebookPicker{border:1px solid var(--tv-border);background:color-mix(in srgb, var(--tv-surface-input) 55%, transparent);border-radius:12px;flex-direction:column;gap:10px;padding:12px;display:flex}._9TEB7a_lorebookPickerHead{flex-wrap:wrap;justify-content:space-between;align-items:center;gap:10px;display:flex}._9TEB7a_lorebookPickerTitleRow{flex-direction:column;gap:2px;display:flex}._9TEB7a_lorebookPickerTitle{font:var(--dsw-font-s-strong-14);color:var(--tv-accent-text)}._9TEB7a_lorebookPickerHint{font:var(--dsw-font-xxs-12);color:var(--tv-text-tertiary)}._9TEB7a_lorebookPickerActions{flex-wrap:wrap;align-items:center;gap:8px;display:flex}._9TEB7a_lorebookOrder{flex-wrap:wrap;align-items:center;gap:6px;display:flex}._9TEB7a_lorebookOrderLabel{font:var(--dsw-font-xxs-12);color:var(--tv-text-tertiary);margin-right:2px}._9TEB7a_lorebookOrderItem{border:1px solid var(--tv-border);background:var(--tv-surface-input);max-width:260px;color:var(--tv-text);cursor:pointer;transition:border-color var(--ds-transition-duration) var(--ds-ease-in-out), background var(--ds-transition-duration) var(--ds-ease-in-out);border-radius:999px;align-items:center;gap:6px;padding:4px 8px 4px 6px;display:inline-flex}._9TEB7a_lorebookOrderItem:hover{border-color:var(--tv-accent-border-strong)}._9TEB7a_lorebookOrderRank{background:var(--tv-accent-soft);min-width:18px;height:18px;color:var(--tv-accent-text);font:var(--dsw-font-xxxs-11);box-sizing:border-box;border-radius:999px;justify-content:center;align-items:center;padding:0 4px;font-weight:700;display:inline-flex}._9TEB7a_lorebookOrderName{font:var(--dsw-font-xxs-12);text-overflow:ellipsis;white-space:nowrap;overflow:hidden}._9TEB7a_lorebookOrderRemove{color:var(--tv-text-tertiary);font-size:14px;line-height:1}._9TEB7a_lorebookGrid{grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:10px;max-height:280px;padding:2px;display:grid;overflow-y:auto}._9TEB7a_lorebookCard{border:1px solid var(--tv-border);background:var(--tv-surface-card);min-width:0;color:var(--tv-text);text-align:left;cursor:pointer;transition:border-color var(--ds-transition-duration) var(--ds-ease-in-out), background var(--ds-transition-duration) var(--ds-ease-in-out), box-shadow var(--ds-transition-duration) var(--ds-ease-in-out), transform var(--ds-transition-duration) var(--ds-ease-in-out);border-radius:10px;align-items:center;gap:8px;padding:10px 12px;display:flex;position:relative}._9TEB7a_lorebookCard:hover{border-color:var(--tv-accent-border-strong);box-shadow:var(--dsw-shadow-lv1);transform:translateY(-1px)}._9TEB7a_lorebookCardSelected{border-color:var(--tv-accent-border-strong);background:linear-gradient(90deg, color-mix(in srgb, var(--tv-accent) 13%, transparent), transparent 160px), var(--tv-surface-card);box-shadow:inset 0 0 0 1px var(--tv-accent-border)}._9TEB7a_lorebookCardCheck{border:1.5px solid var(--tv-border-strong);width:20px;height:20px;color:var(--tv-primary-text);box-sizing:border-box;transition:border-color var(--ds-transition-duration) var(--ds-ease-in-out), background var(--ds-transition-duration) var(--ds-ease-in-out);border-radius:50%;flex-shrink:0;justify-content:center;align-items:center;font-size:13px;font-weight:700;display:flex}._9TEB7a_lorebookCardSelected ._9TEB7a_lorebookCardCheck{border-color:var(--tv-accent-border-strong);background:var(--tv-accent)}._9TEB7a_lorebookCardBody{flex-direction:column;flex:1;gap:2px;min-width:0;display:flex}._9TEB7a_lorebookCardName{font:var(--dsw-font-xs-strong-13);color:var(--tv-text);text-overflow:ellipsis;white-space:nowrap;overflow:hidden}._9TEB7a_lorebookCardMeta{font:var(--dsw-font-xxxs-11);color:var(--tv-text-tertiary);text-overflow:ellipsis;white-space:nowrap;overflow:hidden}._9TEB7a_lorebookRank{background:var(--tv-accent-soft);color:var(--tv-accent-text);border:1px solid var(--tv-accent-border);font:var(--dsw-font-xxxs-11);border-radius:999px;flex-shrink:0;padding:2px 7px;font-weight:700}@media (width<=720px){._9TEB7a_lorebookPickerHead{flex-direction:column;align-items:flex-start}}";
		const tagId = "dsh-tavern/TavernView.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-tavern";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var TavernView_module_css_default = {
			"listItemName": "_9TEB7a_listItemName",
			"badge": "_9TEB7a_badge",
			"modeCardOn": "_9TEB7a_modeCardOn",
			"lorebookCard": "_9TEB7a_lorebookCard",
			"listItemActive": "_9TEB7a_listItemActive",
			"castEmptyTitle": "_9TEB7a_castEmptyTitle",
			"entryContent": "_9TEB7a_entryContent",
			"sendBtn": "_9TEB7a_sendBtn",
			"castOrderName": "_9TEB7a_castOrderName",
			"castPickerTitle": "_9TEB7a_castPickerTitle",
			"createFooter": "_9TEB7a_createFooter",
			"spread": "_9TEB7a_spread",
			"fieldTextarea": "_9TEB7a_fieldTextarea",
			"lorebookOrder": "_9TEB7a_lorebookOrder",
			"castCardMedia": "_9TEB7a_castCardMedia",
			"empty": "_9TEB7a_empty",
			"hint": "_9TEB7a_hint",
			"createSubtitle": "_9TEB7a_createSubtitle",
			"lorebookCardSelected": "_9TEB7a_lorebookCardSelected",
			"msgTime": "_9TEB7a_msgTime",
			"castRankMain": "_9TEB7a_castRankMain",
			"msgNarrator": "_9TEB7a_msgNarrator",
			"sectionTitle": "_9TEB7a_sectionTitle",
			"castGrid": "_9TEB7a_castGrid",
			"castPicker": "_9TEB7a_castPicker",
			"entry": "_9TEB7a_entry",
			"modeRow": "_9TEB7a_modeRow",
			"castSearch": "_9TEB7a_castSearch",
			"castPickerHead": "_9TEB7a_castPickerHead",
			"lorebookGrid": "_9TEB7a_lorebookGrid",
			"lorebookPickerHint": "_9TEB7a_lorebookPickerHint",
			"playMeta": "_9TEB7a_playMeta",
			"chatTitle": "_9TEB7a_chatTitle",
			"createHeader": "_9TEB7a_createHeader",
			"navError": "_9TEB7a_navError",
			"chatMeta": "_9TEB7a_chatMeta",
			"entryHead": "_9TEB7a_entryHead",
			"spinner": "_9TEB7a_spinner",
			"playAvatarMore": "_9TEB7a_playAvatarMore",
			"castCardAvatar": "_9TEB7a_castCardAvatar",
			"composerRow": "_9TEB7a_composerRow",
			"lorebookPickerHead": "_9TEB7a_lorebookPickerHead",
			"nav": "_9TEB7a_nav",
			"body": "_9TEB7a_body",
			"sidebarHead": "_9TEB7a_sidebarHead",
			"castPickerTitleRow": "_9TEB7a_castPickerTitleRow",
			"messages": "_9TEB7a_messages",
			"fieldLabel": "_9TEB7a_fieldLabel",
			"lorebookPickerTitleRow": "_9TEB7a_lorebookPickerTitleRow",
			"lorebookPickerActions": "_9TEB7a_lorebookPickerActions",
			"navSpacer": "_9TEB7a_navSpacer",
			"field": "_9TEB7a_field",
			"createTitle": "_9TEB7a_createTitle",
			"stylePicker": "_9TEB7a_stylePicker",
			"castPickerActions": "_9TEB7a_castPickerActions",
			"listItem": "_9TEB7a_listItem",
			"castOrderAvatar": "_9TEB7a_castOrderAvatar",
			"castCardDesc": "_9TEB7a_castCardDesc",
			"chat": "_9TEB7a_chat",
			"msgSystem": "_9TEB7a_msgSystem",
			"lorebookCardCheck": "_9TEB7a_lorebookCardCheck",
			"content": "_9TEB7a_content",
			"lorebookOrderItem": "_9TEB7a_lorebookOrderItem",
			"lorebookCardBody": "_9TEB7a_lorebookCardBody",
			"createSheet": "_9TEB7a_createSheet",
			"section": "_9TEB7a_section",
			"lorebookCardName": "_9TEB7a_lorebookCardName",
			"castCount": "_9TEB7a_castCount",
			"castCard": "_9TEB7a_castCard",
			"entryKeys": "_9TEB7a_entryKeys",
			"castOrderRank": "_9TEB7a_castOrderRank",
			"castCheck": "_9TEB7a_castCheck",
			"msgName": "_9TEB7a_msgName",
			"createModes": "_9TEB7a_createModes",
			"msgUser": "_9TEB7a_msgUser",
			"playAvatar": "_9TEB7a_playAvatar",
			"castCardTags": "_9TEB7a_castCardTags",
			"lorebookOrderName": "_9TEB7a_lorebookOrderName",
			"playTitle": "_9TEB7a_playTitle",
			"spin": "_9TEB7a_spin",
			"chatHead": "_9TEB7a_chatHead",
			"styleSelect": "_9TEB7a_styleSelect",
			"grid": "_9TEB7a_grid",
			"msg": "_9TEB7a_msg",
			"castEmptyIcon": "_9TEB7a_castEmptyIcon",
			"lorebookCardMeta": "_9TEB7a_lorebookCardMeta",
			"cardAvatar": "_9TEB7a_cardAvatar",
			"list": "_9TEB7a_list",
			"lorebookPicker": "_9TEB7a_lorebookPicker",
			"castOrderItem": "_9TEB7a_castOrderItem",
			"editor": "_9TEB7a_editor",
			"navTitle": "_9TEB7a_navTitle",
			"btnGhost": "_9TEB7a_btnGhost",
			"modeCard": "_9TEB7a_modeCard",
			"row": "_9TEB7a_row",
			"modeCardTitle": "_9TEB7a_modeCardTitle",
			"modeCardText": "_9TEB7a_modeCardText",
			"castOrderItemMain": "_9TEB7a_castOrderItemMain",
			"castRank": "_9TEB7a_castRank",
			"castCardBody": "_9TEB7a_castCardBody",
			"sidebarTitle": "_9TEB7a_sidebarTitle",
			"msgBubble": "_9TEB7a_msgBubble",
			"lorebookOrderLabel": "_9TEB7a_lorebookOrderLabel",
			"createBasics": "_9TEB7a_createBasics",
			"playAvatarStack": "_9TEB7a_playAvatarStack",
			"listItemMeta": "_9TEB7a_listItemMeta",
			"cardName": "_9TEB7a_cardName",
			"castOrder": "_9TEB7a_castOrder",
			"castCountEmpty": "_9TEB7a_castCountEmpty",
			"btnPrimary": "_9TEB7a_btnPrimary",
			"listItemAvatar": "_9TEB7a_listItemAvatar",
			"checkRow": "_9TEB7a_checkRow",
			"view": "_9TEB7a_view",
			"btn": "_9TEB7a_btn",
			"castPickerHint": "_9TEB7a_castPickerHint",
			"lorebookOrderRank": "_9TEB7a_lorebookOrderRank",
			"card": "_9TEB7a_card",
			"navTab": "_9TEB7a_navTab",
			"navTabActive": "_9TEB7a_navTabActive",
			"btnDanger": "_9TEB7a_btnDanger",
			"fieldInput": "_9TEB7a_fieldInput",
			"castOrderLabel": "_9TEB7a_castOrderLabel",
			"castCardName": "_9TEB7a_castCardName",
			"lorebookRank": "_9TEB7a_lorebookRank",
			"createHeaderText": "_9TEB7a_createHeaderText",
			"castEmpty": "_9TEB7a_castEmpty",
			"castCardSelected": "_9TEB7a_castCardSelected",
			"lorebookPickerTitle": "_9TEB7a_lorebookPickerTitle",
			"composer": "_9TEB7a_composer",
			"entryList": "_9TEB7a_entryList",
			"cardTags": "_9TEB7a_cardTags",
			"sidebar": "_9TEB7a_sidebar",
			"composerInput": "_9TEB7a_composerInput",
			"listItemBody": "_9TEB7a_listItemBody",
			"lorebookOrderRemove": "_9TEB7a_lorebookOrderRemove",
			"fieldSelect": "_9TEB7a_fieldSelect",
			"modeLabel": "_9TEB7a_modeLabel"
		};
		//#endregion
		//#region src/client/components/common.tsx
		function Button(props) {
			const cls = props.variant === "primary" ? `${TavernView_module_css_default.btn} ${TavernView_module_css_default.btnPrimary}` : props.variant === "danger" ? `${TavernView_module_css_default.btn} ${TavernView_module_css_default.btnDanger}` : props.variant === "ghost" ? `${TavernView_module_css_default.btn} ${TavernView_module_css_default.btnGhost}` : TavernView_module_css_default.btn;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				className: cls,
				onClick: props.onClick,
				disabled: props.disabled,
				title: props.title,
				children: props.children
			});
		}
		function Field(props) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
				className: TavernView_module_css_default.field,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: TavernView_module_css_default.fieldLabel,
					children: props.label
				}), props.children]
			});
		}
		function TextInput(props) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
				className: TavernView_module_css_default.fieldInput,
				value: props.value,
				placeholder: props.placeholder,
				disabled: props.disabled,
				onChange: (event) => props.onChange(event.target.value)
			});
		}
		function TextArea(props) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
				className: TavernView_module_css_default.fieldTextarea,
				value: props.value,
				placeholder: props.placeholder,
				rows: props.rows,
				disabled: props.disabled,
				onChange: (event) => props.onChange(event.target.value)
			});
		}
		function Select(props) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
				className: TavernView_module_css_default.fieldSelect,
				value: props.value ?? "",
				onChange: (event) => {
					const value = event.target.value;
					props.onChange(value === "" ? void 0 : value);
				},
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
					value: "",
					children: props.placeholder ?? "（无）"
				}), props.options.map((option) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
					value: option.value,
					children: option.label
				}, option.value))]
			});
		}
		function Checkbox(props) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
				className: TavernView_module_css_default.checkRow,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
					type: "checkbox",
					checked: props.checked,
					onChange: (event) => props.onChange(event.target.checked)
				}), props.label]
			});
		}
		function Spinner() {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: TavernView_module_css_default.spinner,
				"aria-label": "加载中"
			});
		}
		function Empty(props) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: TavernView_module_css_default.empty,
				children: props.text
			});
		}
		/** Simple confirm dialog via window.confirm. */
		function confirmAction(message) {
			return window.confirm(message);
		}
		//#endregion
		//#region src/client/components/ChatPanel.tsx
		/**
		* Chat panel: play list, session message thread (from the DSH session
		* snapshot), composer, and play creation. The conversation itself is the
		* DSH session — sending routes through the conversation service.
		*/
		function firstGrapheme(value) {
			const trimmed = value.trim();
			return trimmed === "" ? "?" : Array.from(trimmed)[0] ?? "?";
		}
		function compactText(value) {
			return (value ?? "").replace(/\s+/g, " ").trim();
		}
		function matchesCharacter(character, query) {
			return [
				character.name,
				character.description ?? "",
				character.personality ?? "",
				...character.tags ?? []
			].join("\n").toLowerCase().includes(query);
		}
		function matchesLorebook(book, query) {
			return [book.name, book.description ?? ""].join("\n").toLowerCase().includes(query);
		}
		function ChatPanel(props) {
			const { running } = props;
			const [draft, setDraft] = (0, react.useState)("");
			const [title, setTitle] = (0, react.useState)("");
			const [selectedIds, setSelectedIds] = (0, react.useState)([]);
			const [characterQuery, setCharacterQuery] = (0, react.useState)("");
			const [lorebookIds, setLorebookIds] = (0, react.useState)([]);
			const [lorebookQuery, setLorebookQuery] = (0, react.useState)("");
			const [presetId, setPresetId] = (0, react.useState)(void 0);
			const [narratorEnabled, setNarratorEnabled] = (0, react.useState)(false);
			const [multiAgent, setMultiAgent] = (0, react.useState)(true);
			const [creating, setCreating] = (0, react.useState)(false);
			const bottomRef = (0, react.useRef)(null);
			(0, react.useEffect)(() => {
				bottomRef.current?.scrollIntoView({ block: "end" });
			}, [props.messages.length]);
			const selectedCharacters = selectedIds.map((id) => props.characters.find((character) => character.id === id)).filter((character) => character !== void 0);
			const selectedLorebooks = lorebookIds.map((id) => props.lorebooks.find((book) => book.id === id)).filter((book) => book !== void 0);
			const visibleCharacters = (0, react.useMemo)(() => {
				const query = characterQuery.trim().toLowerCase();
				const selected = new Set(selectedIds);
				const matched = query === "" ? props.characters : props.characters.filter((character) => matchesCharacter(character, query));
				return [...matched.filter((character) => selected.has(character.id)), ...matched.filter((character) => !selected.has(character.id))];
			}, [
				characterQuery,
				props.characters,
				selectedIds
			]);
			const visibleLorebooks = (0, react.useMemo)(() => {
				const query = lorebookQuery.trim().toLowerCase();
				const selected = new Set(lorebookIds);
				const matched = query === "" ? props.lorebooks : props.lorebooks.filter((book) => matchesLorebook(book, query));
				const byId = new Map(matched.map((book) => [book.id, book]));
				return [...lorebookIds.map((id) => byId.get(id)).filter((book) => book !== void 0), ...matched.filter((book) => !selected.has(book.id))];
			}, [
				lorebookQuery,
				lorebookIds,
				props.lorebooks
			]);
			const toggleSelect = (id) => {
				setSelectedIds((prev) => prev.includes(id) ? prev.filter((cid) => cid !== id) : [...prev, id]);
			};
			const toggleLorebook = (id) => {
				setLorebookIds((prev) => prev.includes(id) ? prev.filter((bid) => bid !== id) : [...prev, id]);
			};
			const clearLorebooks = () => {
				setLorebookIds([]);
			};
			const makeMain = (id) => {
				setSelectedIds((prev) => prev[0] === id ? prev : [id, ...prev.filter((cid) => cid !== id)]);
			};
			const clearSelection = () => {
				setSelectedIds([]);
			};
			const submitCreate = async () => {
				if (selectedCharacters.length === 0) return;
				setCreating(true);
				try {
					await props.onCreatePlay(title.trim(), selectedCharacters.map((character) => character.id), selectedLorebooks.map((book) => book.id), presetId, narratorEnabled, multiAgent && props.multiAgentAvailable);
					setTitle("");
					setSelectedIds([]);
					setCharacterQuery("");
					setLorebookIds([]);
					setLorebookQuery("");
					setPresetId(void 0);
				} finally {
					setCreating(false);
				}
			};
			const send = () => {
				const content = draft.trim();
				if (content === "" || running) return;
				setDraft("");
				props.onSend(content);
			};
			const inPlaySession = props.activeSessionId !== void 0;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: TavernView_module_css_default.body,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: TavernView_module_css_default.sidebar,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: TavernView_module_css_default.sidebarHead,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: TavernView_module_css_default.sidebarTitle,
							children: "酒馆会话"
						}), props.activePlayId !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
							variant: "ghost",
							onClick: () => props.onSelectPlay(null),
							children: "＋ 新建"
						})]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: TavernView_module_css_default.list,
						children: [props.plays.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Empty, { text: "还没有会话，从右侧挑选角色开始第一场扮演" }), props.plays.map((play) => {
							const cast = play.characterIds.map((id) => props.characters.find((character) => character.id === id)).filter((character) => character !== void 0);
							return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
								type: "button",
								className: `${TavernView_module_css_default.listItem} ${play.id === props.activePlayId ? TavernView_module_css_default.listItemActive : ""}`,
								onClick: () => props.onSelectPlay(play.id),
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: TavernView_module_css_default.playAvatarStack,
									"aria-hidden": "true",
									children: [cast.slice(0, 3).map((character) => character.avatar !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("img", {
										className: TavernView_module_css_default.playAvatar,
										src: avatarSrc(character.avatar),
										alt: ""
									}, character.id) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: TavernView_module_css_default.playAvatar,
										children: firstGrapheme(character.name)
									}, character.id)), cast.length > 3 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										className: TavernView_module_css_default.playAvatarMore,
										children: ["+", cast.length - 3]
									})]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: TavernView_module_css_default.listItemBody,
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: TavernView_module_css_default.playTitle,
											children: play.title
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: TavernView_module_css_default.playMeta,
											children: cast.length > 0 ? `${cast.slice(0, 3).map((character) => character.name).join(" · ")}${cast.length > 3 ? " …" : ""}` : `${play.characterIds.length} 位角色`
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											className: TavernView_module_css_default.listItemMeta,
											children: [
												play.characterIds.length,
												" 角",
												play.multiAgent ? "·多 agent" : "·经典",
												(play.lorebookIds?.length ?? 0) > 0 ? `·${play.lorebookIds?.length} 书` : "",
												play.narratorEnabled ? "·叙" : ""
											]
										})
									]
								})]
							}, play.id);
						})]
					})]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: TavernView_module_css_default.chat,
					children: props.activePlayId === null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: TavernView_module_css_default.content,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: TavernView_module_css_default.createSheet,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: TavernView_module_css_default.createHeader,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: TavernView_module_css_default.createHeaderText,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											className: TavernView_module_css_default.createTitle,
											children: "✦ 开启新扮演"
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											className: TavernView_module_css_default.createSubtitle,
											children: "新扮演会创建一个 DSH 会话（导演 agent）：角色卡组成系统提示，世界书按关键词自动注入， 聊天记录与轨迹完全走 DSH 会话。"
										})]
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: `${TavernView_module_css_default.castCount} ${selectedCharacters.length === 0 ? TavernView_module_css_default.castCountEmpty : ""}`,
										children: selectedCharacters.length === 0 ? "尚未选择角色" : `已选 ${selectedCharacters.length} 位`
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: TavernView_module_css_default.createBasics,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
										label: "会话标题（留空使用第一位角色名）",
										children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											className: TavernView_module_css_default.fieldInput,
											value: title,
											placeholder: "例如：酒馆之夜",
											onChange: (event) => setTitle(event.target.value)
										})
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
										label: "预设",
										children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Select, {
											value: presetId,
											onChange: setPresetId,
											options: props.presets.map((preset) => ({
												value: preset.id,
												label: preset.name
											})),
											placeholder: "（使用默认模型）"
										})
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: TavernView_module_css_default.lorebookPicker,
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: TavernView_module_css_default.lorebookPickerHead,
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
												className: TavernView_module_css_default.lorebookPickerTitleRow,
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: TavernView_module_css_default.lorebookPickerTitle,
													children: "世界书（可多选）"
												}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: TavernView_module_css_default.lorebookPickerHint,
													children: "按选择顺序合并注入，自动关键词激活"
												})]
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
												className: TavernView_module_css_default.lorebookPickerActions,
												children: [
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
														className: TavernView_module_css_default.castSearch,
														value: lorebookQuery,
														placeholder: "搜索世界书…",
														"aria-label": "搜索世界书",
														onChange: (event) => setLorebookQuery(event.target.value)
													}),
													selectedLorebooks.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
														variant: "ghost",
														onClick: clearLorebooks,
														children: "清空"
													}),
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														className: `${TavernView_module_css_default.castCount} ${selectedLorebooks.length === 0 ? TavernView_module_css_default.castCountEmpty : ""}`,
														children: selectedLorebooks.length === 0 ? "未选择" : `已选 ${selectedLorebooks.length} 本`
													})
												]
											})]
										}),
										selectedLorebooks.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: TavernView_module_css_default.lorebookOrder,
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: TavernView_module_css_default.lorebookOrderLabel,
												children: "注入顺序"
											}), selectedLorebooks.map((book, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
												type: "button",
												className: TavernView_module_css_default.lorebookOrderItem,
												onClick: () => toggleLorebook(book.id),
												title: `点击移除「${book.name}」`,
												children: [
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														className: TavernView_module_css_default.lorebookOrderRank,
														children: index + 1
													}),
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														className: TavernView_module_css_default.lorebookOrderName,
														children: book.name
													}),
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														className: TavernView_module_css_default.lorebookOrderRemove,
														"aria-hidden": "true",
														children: "×"
													})
												]
											}, book.id))]
										}),
										props.lorebooks.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: TavernView_module_css_default.castEmpty,
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: TavernView_module_css_default.castEmptyIcon,
													children: "✦"
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
													className: TavernView_module_css_default.castEmptyTitle,
													children: "还没有世界书"
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: TavernView_module_css_default.hint,
													children: "导入 ST 世界书 JSON 后，可以在这里一次挂载多本。"
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
													variant: "primary",
													onClick: props.onGoToLorebooks,
													children: "去「世界书」页导入"
												})
											]
										}) : visibleLorebooks.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: TavernView_module_css_default.castEmpty,
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: TavernView_module_css_default.castEmptyIcon,
													children: "✦"
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
													className: TavernView_module_css_default.castEmptyTitle,
													children: "没有找到匹配的世界书"
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: TavernView_module_css_default.hint,
													children: "试试其他书名或描述关键词。"
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
													onClick: () => setLorebookQuery(""),
													children: "清除搜索"
												})
											]
										}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											className: TavernView_module_css_default.lorebookGrid,
											children: visibleLorebooks.map((book) => {
												const rank = lorebookIds.indexOf(book.id);
												const isSelected = rank >= 0;
												const description = compactText(book.description);
												return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
													type: "button",
													className: `${TavernView_module_css_default.lorebookCard} ${isSelected ? TavernView_module_css_default.lorebookCardSelected : ""}`,
													"aria-pressed": isSelected,
													title: isSelected ? `点击移除「${book.name}」` : `点击挂载「${book.name}」`,
													onClick: () => toggleLorebook(book.id),
													children: [
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
															className: TavernView_module_css_default.lorebookCardCheck,
															"aria-hidden": "true",
															children: isSelected ? "✓" : ""
														}),
														/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
															className: TavernView_module_css_default.lorebookCardBody,
															children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
																className: TavernView_module_css_default.lorebookCardName,
																children: book.name
															}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
																className: TavernView_module_css_default.lorebookCardMeta,
																children: [
																	book.entryCount ?? 0,
																	" 个条目",
																	description !== "" ? ` · ${description}` : ""
																]
															})]
														}),
														isSelected && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
															className: TavernView_module_css_default.lorebookRank,
															children: ["#", rank + 1]
														})
													]
												}, book.id);
											})
										})
									]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: TavernView_module_css_default.createModes,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
										type: "button",
										className: `${TavernView_module_css_default.modeCard} ${multiAgent && props.multiAgentAvailable ? TavernView_module_css_default.modeCardOn : ""}`,
										disabled: !props.multiAgentAvailable,
										"aria-pressed": multiAgent && props.multiAgentAvailable,
										onClick: () => setMultiAgent((prev) => !prev),
										title: props.multiAgentAvailable ? "每个角色使用独立的 DSH agent 与记忆" : "当前未检测到 agent-loop 工厂，不可用",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: TavernView_module_css_default.modeCardTitle,
											children: "多 agent 模式"
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											className: TavernView_module_css_default.modeCardText,
											children: ["每个角色是独立的 DSH agent，导演通过 tavern_speak 工具调遣", !props.multiAgentAvailable ? "（不可用）" : ""]
										})]
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
										type: "button",
										className: `${TavernView_module_css_default.modeCard} ${narratorEnabled ? TavernView_module_css_default.modeCardOn : ""}`,
										"aria-pressed": narratorEnabled,
										onClick: () => setNarratorEnabled((prev) => !prev),
										title: "导演额外描写场景与旁白",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: TavernView_module_css_default.modeCardTitle,
											children: "叙述者"
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: TavernView_module_css_default.modeCardText,
											children: "导演负责描写场景过渡与旁白"
										})]
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: TavernView_module_css_default.castPicker,
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: TavernView_module_css_default.castPickerHead,
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
												className: TavernView_module_css_default.castPickerTitleRow,
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: TavernView_module_css_default.castPickerTitle,
													children: "登场角色"
												}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: TavernView_module_css_default.castPickerHint,
													children: "点击卡片加入或移除 · 第 1 位为主角"
												})]
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
												className: TavernView_module_css_default.castPickerActions,
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
													className: TavernView_module_css_default.castSearch,
													value: characterQuery,
													placeholder: "搜索名字、标签或设定…",
													"aria-label": "搜索角色",
													onChange: (event) => setCharacterQuery(event.target.value)
												}), selectedCharacters.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
													variant: "ghost",
													onClick: clearSelection,
													children: "清空"
												})]
											})]
										}),
										selectedCharacters.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: TavernView_module_css_default.castOrder,
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: TavernView_module_css_default.castOrderLabel,
												children: "出场顺序"
											}), selectedCharacters.map((character, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
												type: "button",
												className: `${TavernView_module_css_default.castOrderItem} ${index === 0 ? TavernView_module_css_default.castOrderItemMain : ""}`,
												onClick: () => makeMain(character.id),
												title: index === 0 ? "当前主角（第 1 位）" : `点击将「${character.name}」设为主角`,
												children: [
													character.avatar !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("img", {
														className: TavernView_module_css_default.castOrderAvatar,
														src: avatarSrc(character.avatar),
														alt: ""
													}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														className: TavernView_module_css_default.castOrderAvatar,
														children: firstGrapheme(character.name)
													}),
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														className: TavernView_module_css_default.castOrderName,
														children: character.name
													}),
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														className: TavernView_module_css_default.castOrderRank,
														children: index === 0 ? "★ 主角" : `#${index + 1}`
													})
												]
											}, character.id))]
										}),
										props.characters.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: TavernView_module_css_default.castEmpty,
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: TavernView_module_css_default.castEmptyIcon,
													children: "✦"
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
													className: TavernView_module_css_default.castEmptyTitle,
													children: "角色库还是空的"
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: TavernView_module_css_default.hint,
													children: "导入 SillyTavern / TauriTavern 人物卡后，就能在这里挑选登场角色。"
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
													variant: "primary",
													onClick: props.onGoToCharacters,
													children: "去「角色」页导入"
												})
											]
										}) : visibleCharacters.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: TavernView_module_css_default.castEmpty,
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: TavernView_module_css_default.castEmptyIcon,
													children: "✦"
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
													className: TavernView_module_css_default.castEmptyTitle,
													children: "没有找到匹配的角色"
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: TavernView_module_css_default.hint,
													children: "试试其他名字、标签或设定关键词。"
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
													onClick: () => setCharacterQuery(""),
													children: "清除搜索"
												})
											]
										}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											className: TavernView_module_css_default.castGrid,
											children: visibleCharacters.map((character) => {
												const rank = selectedIds.indexOf(character.id);
												const isSelected = rank >= 0;
												const summary = compactText(character.description) || compactText(character.personality) || "暂无设定摘要，点击选择这位角色";
												return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
													type: "button",
													className: `${TavernView_module_css_default.castCard} ${isSelected ? TavernView_module_css_default.castCardSelected : ""}`,
													"aria-pressed": isSelected,
													title: isSelected ? `点击移除「${character.name}」` : `点击选择「${character.name}」`,
													onClick: () => toggleSelect(character.id),
													children: [
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
															className: TavernView_module_css_default.castCardMedia,
															children: character.avatar !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("img", {
																className: TavernView_module_css_default.castCardAvatar,
																src: avatarSrc(character.avatar),
																alt: ""
															}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
																className: TavernView_module_css_default.castCardAvatar,
																children: firstGrapheme(character.name)
															})
														}),
														isSelected && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
															className: `${TavernView_module_css_default.castRank} ${rank === 0 ? TavernView_module_css_default.castRankMain : ""}`,
															children: rank === 0 ? "★ 主角" : `#${rank + 1}`
														}),
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
															className: TavernView_module_css_default.castCheck,
															"aria-hidden": "true",
															children: isSelected ? "✓" : ""
														}),
														/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
															className: TavernView_module_css_default.castCardBody,
															children: [
																/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
																	className: TavernView_module_css_default.castCardName,
																	children: character.name
																}),
																/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
																	className: TavernView_module_css_default.castCardDesc,
																	children: summary
																}),
																(character.tags?.length ?? 0) > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
																	className: TavernView_module_css_default.castCardTags,
																	children: character.tags.slice(0, 3).map((tag) => `#${tag}`).join(" ")
																})
															]
														})
													]
												}, character.id);
											})
										})
									]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: TavernView_module_css_default.createFooter,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
										variant: "primary",
										disabled: selectedCharacters.length === 0 || creating,
										onClick: () => void submitCreate(),
										children: creating ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Spinner, {}) : "开始扮演"
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: TavernView_module_css_default.hint,
										children: selectedCharacters.length === 0 ? "至少选择一位角色才能开场。" : selectedCharacters[0] !== void 0 ? `第一位「${selectedCharacters[0].name}」将作为主角。` : ""
									})]
								})
							]
						})
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: TavernView_module_css_default.chatHead,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: TavernView_module_css_default.chatTitle,
									children: props.activePlayTitle ?? "酒馆会话"
								}),
								!inPlaySession && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: TavernView_module_css_default.badge,
									children: "当前会话未绑定，请从左侧选择"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { style: { flex: 1 } }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
									variant: "danger",
									onClick: () => {
										if (confirmAction(`删除会话「${props.activePlayTitle ?? ""}」？`)) props.onDeletePlay(props.activePlayId);
									},
									children: "删除"
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: TavernView_module_css_default.messages,
							children: [
								props.messages.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Empty, { text: "对话尚未开始。发送第一句话开始这场扮演。" }),
								props.messages.map((message) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(MessageRow, { message }, message.id)),
								running && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: TavernView_module_css_default.msg,
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										className: TavernView_module_css_default.msgName,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Spinner, {}), " 角色正在酝酿台词…"]
									})
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { ref: bottomRef })
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: TavernView_module_css_default.composer,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: TavernView_module_css_default.composerRow,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
									className: TavernView_module_css_default.composerInput,
									value: draft,
									placeholder: inPlaySession ? "对角色说话…" : "请先在左侧选择一个酒馆会话",
									disabled: running || !inPlaySession,
									onChange: (event) => setDraft(event.target.value),
									onKeyDown: (event) => {
										if (event.key === "Enter" && !event.shiftKey) {
											event.preventDefault();
											send();
										}
									}
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: TavernView_module_css_default.sendBtn,
									disabled: running || draft.trim() === "" || !inPlaySession,
									onClick: send,
									children: running ? "…" : "发送"
								})]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: TavernView_module_css_default.modeRow,
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "聊天通过 DSH 会话进行：回复会记录在会话日志（轨迹）中；酒馆会话只显示在本页，不会出现在「对话」页。" })
							})]
						})
					] })
				})]
			});
		}
		function MessageRow(props) {
			const { message } = props;
			const cls = message.kind === "user" ? `${TavernView_module_css_default.msg} ${TavernView_module_css_default.msgUser}` : message.name === void 0 ? `${TavernView_module_css_default.msg} ${TavernView_module_css_default.msgNarrator}` : TavernView_module_css_default.msg;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: cls,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: TavernView_module_css_default.msgName,
					children: message.kind === "user" ? "你" : message.name ?? "叙述者"
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: TavernView_module_css_default.msgBubble,
					children: message.text
				})]
			});
		}
		//#endregion
		//#region src/client/components/CharacterPanel.tsx
		/**
		* Character library panel: card grid, import (PNG/JSON), editor, export.
		*/
		function CharacterPanel(props) {
			const selected = props.characters.find((c) => c.id === props.selectedId) ?? null;
			const fileRef = (0, react.useRef)(null);
			const [importing, setImporting] = (0, react.useState)(false);
			const [importText, setImportText] = (0, react.useState)("");
			const [showImport, setShowImport] = (0, react.useState)(false);
			const importFile = async (file) => {
				setImporting(true);
				try {
					const input = file.type === "image/png" || file.name.toLowerCase().endsWith(".png") ? await fileToDataUrl(file) : await fileToText(file);
					await props.api.createCharacter({
						input,
						source: file.name
					});
					await props.onChanged();
				} catch (error) {
					props.onError(error instanceof Error ? error.message : String(error));
				} finally {
					setImporting(false);
				}
			};
			const importTextCard = async () => {
				if (importText.trim() === "") return;
				setImporting(true);
				try {
					await props.api.createCharacter({
						input: importText.trim(),
						source: "粘贴"
					});
					setImportText("");
					setShowImport(false);
					await props.onChanged();
				} catch (error) {
					props.onError(error instanceof Error ? error.message : String(error));
				} finally {
					setImporting(false);
				}
			};
			const deleteSelected = async () => {
				if (selected === null) return;
				if (!confirmAction(`删除角色「${selected.card.data.name}」？相关会话将保留历史但不再指派。`)) return;
				await props.api.deleteCharacter(selected.id);
				props.onSelect(null);
				await props.onChanged();
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: TavernView_module_css_default.body,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: TavernView_module_css_default.sidebar,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: TavernView_module_css_default.sidebarHead,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: TavernView_module_css_default.sidebarTitle,
									children: [
										"角色库（",
										props.characters.length,
										"）"
									]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
									onClick: () => {
										setShowImport((prev) => !prev);
									},
									children: "导入"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									ref: fileRef,
									type: "file",
									accept: ".png,.json,image/png,application/json",
									style: { display: "none" },
									onChange: (event) => {
										const file = event.target.files?.[0];
										if (file !== void 0) importFile(file);
										event.target.value = "";
									}
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
									variant: "ghost",
									onClick: () => fileRef.current?.click(),
									disabled: importing,
									children: importing ? "导入中…" : "选择文件"
								})
							]
						}),
						showImport && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: TavernView_module_css_default.section,
							style: {
								padding: "8px 10px",
								gap: 6
							},
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: TavernView_module_css_default.hint,
									children: "支持 SillyTavern / TauriTavern 人物卡：PNG 卡（含 chara 文本块）或 JSON 卡（v1/v2/v3）。"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(TextArea, {
									value: importText,
									onChange: setImportText,
									placeholder: "粘贴卡片 JSON…（{\"spec\":\"chara_card_v2\",…}）",
									rows: 4
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: TavernView_module_css_default.row,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
										variant: "primary",
										disabled: importing || importText.trim() === "",
										onClick: () => void importTextCard(),
										children: "导入 JSON"
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
										onClick: () => fileRef.current?.click(),
										disabled: importing,
										children: "导入 PNG / JSON 文件"
									})]
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: TavernView_module_css_default.list,
							children: [props.characters.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Empty, { text: "角色库为空" }), props.characters.map((character) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
								type: "button",
								className: `${TavernView_module_css_default.listItem} ${character.id === props.selectedId ? TavernView_module_css_default.listItemActive : ""}`,
								onClick: () => props.onSelect(character.id),
								children: [character.avatar !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("img", {
									className: TavernView_module_css_default.listItemAvatar,
									src: avatarSrc(character.avatar),
									alt: ""
								}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: TavernView_module_css_default.listItemAvatar }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: TavernView_module_css_default.listItemName,
									children: character.card.data.name
								})]
							}, character.id))]
						})
					]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: TavernView_module_css_default.content,
					children: selected === null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Empty, { text: "选择左侧角色查看详情，或导入新的人物卡" }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(CharacterEditor, {
						api: props.api,
						character: selected,
						onChanged: props.onChanged,
						onError: props.onError,
						onDelete: deleteSelected
					}, selected.id)
				})]
			});
		}
		function CharacterEditor(props) {
			const data = props.character.card.data;
			const [name, setName] = (0, react.useState)(data.name);
			const [description, setDescription] = (0, react.useState)(data.description);
			const [personality, setPersonality] = (0, react.useState)(data.personality);
			const [scenario, setScenario] = (0, react.useState)(data.scenario);
			const [firstMes, setFirstMes] = (0, react.useState)(data.first_mes);
			const [mesExample, setMesExample] = (0, react.useState)(data.mes_example);
			const [systemPrompt, setSystemPrompt] = (0, react.useState)(data.system_prompt);
			const [postHistory, setPostHistory] = (0, react.useState)(data.post_history_instructions);
			const [tags, setTags] = (0, react.useState)(data.tags.join(", "));
			const [saving, setSaving] = (0, react.useState)(false);
			const save = async () => {
				setSaving(true);
				try {
					await props.api.updateCharacter(props.character.id, {
						name: name.trim() || data.name,
						description,
						personality,
						scenario,
						first_mes: firstMes,
						mes_example: mesExample,
						system_prompt: systemPrompt,
						post_history_instructions: postHistory,
						tags: tags.split(",").map((t) => t.trim()).filter((t) => t !== ""),
						creator: data.creator,
						creator_notes: data.creator_notes,
						character_version: data.character_version,
						alternate_greetings: data.alternate_greetings,
						...data.group_only_greetings !== void 0 ? { group_only_greetings: data.group_only_greetings } : {},
						...data.character_book !== void 0 ? { character_book: data.character_book } : {},
						extensions: data.extensions
					});
					await props.onChanged();
					props.onError(null);
				} catch (error) {
					props.onError(error instanceof Error ? error.message : String(error));
				} finally {
					setSaving(false);
				}
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: TavernView_module_css_default.editor,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: TavernView_module_css_default.row,
						style: { justifyContent: "space-between" },
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: TavernView_module_css_default.row,
							children: [
								props.character.avatar !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("img", {
									className: TavernView_module_css_default.cardAvatar,
									src: avatarSrc(props.character.avatar),
									alt: ""
								}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: TavernView_module_css_default.cardAvatar }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: TavernView_module_css_default.sectionTitle,
									style: {
										border: "none",
										padding: 0
									},
									children: data.name
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: TavernView_module_css_default.badge,
									children: data.character_version || "v?"
								})
							]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: TavernView_module_css_default.row,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
								onClick: () => {
									const anchor = document.createElement("a");
									anchor.href = props.api.exportCharacterUrl(props.character.id);
									anchor.download = `${data.name}.png`;
									document.body.appendChild(anchor);
									anchor.click();
									anchor.remove();
								},
								children: "导出 PNG 卡"
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
								variant: "danger",
								onClick: () => void props.onDelete(),
								children: "删除"
							})]
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
						label: "名字",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TextInput, {
							value: name,
							onChange: setName
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
						label: "角色设定（description）",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TextArea, {
							value: description,
							onChange: setDescription,
							rows: 5
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
						label: "性格（personality）",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TextArea, {
							value: personality,
							onChange: setPersonality,
							rows: 4
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
						label: "场景（scenario）",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TextArea, {
							value: scenario,
							onChange: setScenario,
							rows: 3
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
						label: "开场白（first_mes）",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TextArea, {
							value: firstMes,
							onChange: setFirstMes,
							rows: 3
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
						label: "对话示例（mes_example）",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TextArea, {
							value: mesExample,
							onChange: setMesExample,
							rows: 4
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
						label: "系统提示（system_prompt）",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TextArea, {
							value: systemPrompt,
							onChange: setSystemPrompt,
							rows: 3
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
						label: "历史后指令（post_history_instructions）",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TextArea, {
							value: postHistory,
							onChange: setPostHistory,
							rows: 2
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
						label: "标签（逗号分隔）",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TextInput, {
							value: tags,
							onChange: setTags
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: TavernView_module_css_default.row,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
							variant: "primary",
							disabled: saving,
							onClick: () => void save(),
							children: saving ? "保存中…" : "保存修改"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: TavernView_module_css_default.hint,
							children: "多 agent 模式下，每个角色是一个独立的 DSH agent（独立会话与记忆）， 其系统提示由本卡自动组装。"
						})]
					})
				]
			});
		}
		//#endregion
		//#region src/client/components/LorebookPanel.tsx
		/**
		* World-book (lorebook) panel: book list, entry viewer/editor, import/export.
		*/
		function LorebookPanel(props) {
			const selected = props.lorebooks.find((book) => book.id === props.selectedId) ?? null;
			const [importText, setImportText] = (0, react.useState)("");
			const [newName, setNewName] = (0, react.useState)("");
			const importBook = async (text) => {
				try {
					await props.api.createLorebook({
						input: text,
						name: newName.trim() || void 0
					});
					setImportText("");
					setNewName("");
					await props.onChanged();
				} catch (error) {
					props.onError(error instanceof Error ? error.message : String(error));
				}
			};
			const deleteSelected = async () => {
				if (selected === null) return;
				if (!confirmAction(`删除世界书「${selected.name}」？使用它的会话将停止注入。`)) return;
				await props.api.deleteLorebook(selected.id);
				props.onSelect(null);
				await props.onChanged();
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: TavernView_module_css_default.body,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: TavernView_module_css_default.sidebar,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: TavernView_module_css_default.sidebarHead,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: TavernView_module_css_default.sidebarTitle,
							children: [
								"世界书（",
								props.lorebooks.length,
								"）"
							]
						})
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: TavernView_module_css_default.list,
						children: [props.lorebooks.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Empty, { text: "还没有世界书" }), props.lorebooks.map((book) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
							type: "button",
							className: `${TavernView_module_css_default.listItem} ${book.id === props.selectedId ? TavernView_module_css_default.listItemActive : ""}`,
							onClick: () => props.onSelect(book.id),
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: TavernView_module_css_default.listItemName,
								children: book.name
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: TavernView_module_css_default.listItemMeta,
								children: [book.book.entries.length, " 条"]
							})]
						}, book.id))]
					})]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: TavernView_module_css_default.content,
					children: selected === null ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: TavernView_module_css_default.section,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: TavernView_module_css_default.sectionTitle,
								children: "导入世界书"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: TavernView_module_css_default.hint,
								children: "支持 SillyTavern / TauriTavern 世界书 JSON （entries 为对象或数组均可），也支持角色卡内嵌 character_book 结构。 世界书条目会在扮演时按关键词自动激活并注入提示词。"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
								label: "书名（可选）",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TextInput, {
									value: newName,
									onChange: setNewName,
									placeholder: "例如：剑与魔法大陆"
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
								label: "世界书 JSON",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TextArea, {
									value: importText,
									onChange: setImportText,
									rows: 8,
									placeholder: "{\"entries\": {\"0\": {\"key\": [\"酒馆\"], \"content\": \"…\"}}}"
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: TavernView_module_css_default.row,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
									variant: "primary",
									disabled: importText.trim() === "",
									onClick: () => void importBook(importText),
									children: "导入"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
									onClick: () => {
										const input = document.createElement("input");
										input.type = "file";
										input.accept = ".json,application/json";
										input.onchange = () => {
											const file = input.files?.[0];
											if (file !== void 0) fileToText(file).then((text) => importBook(text)).catch((error) => {
												props.onError(error instanceof Error ? error.message : String(error));
											});
										};
										input.click();
									},
									children: "选择文件"
								})]
							}),
							props.lorebooks.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Empty, { text: "左侧选择世界书查看条目" })
						]
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(LorebookEditor, {
						api: props.api,
						book: selected,
						onChanged: props.onChanged,
						onError: props.onError,
						onDelete: deleteSelected
					})
				})]
			});
		}
		function LorebookEditor(props) {
			const [name, setName] = (0, react.useState)(props.book.name);
			const [entries, setEntries] = (0, react.useState)(props.book.book.entries);
			const [saving, setSaving] = (0, react.useState)(false);
			const save = async () => {
				setSaving(true);
				try {
					await props.api.updateLorebook(props.book.id, {
						name,
						entries
					}, name);
					await props.onChanged();
				} catch (error) {
					props.onError(error instanceof Error ? error.message : String(error));
				} finally {
					setSaving(false);
				}
			};
			const updateEntry = (index, patch) => {
				setEntries((prev) => prev.map((entry, i) => i === index ? {
					...entry,
					...patch
				} : entry));
			};
			const addEntry = () => {
				const uid = entries.length > 0 ? Math.max(...entries.map((e) => e.uid)) + 1 : 0;
				setEntries((prev) => [...prev, {
					uid,
					key: [],
					keysecondary: [],
					comment: "",
					content: "",
					constant: false,
					vectorized: false,
					selective: true,
					selectiveLogic: 0,
					addMemo: false,
					order: 100,
					position: 0,
					disable: false,
					ignoreBudget: false,
					excludeRecursion: false,
					preventRecursion: false,
					matchPersonaDescription: false,
					matchCharacterDescription: false,
					matchCharacterPersonality: false,
					matchCharacterDepthPrompt: false,
					matchScenario: false,
					matchCreatorNotes: false,
					delayUntilRecursion: 0,
					probability: 100,
					useProbability: true,
					depth: 4,
					outletName: "",
					group: "",
					groupOverride: false,
					groupWeight: 100,
					scanDepth: null,
					caseSensitive: null,
					matchWholeWords: null,
					useGroupScoring: null,
					automationId: "",
					role: 0,
					sticky: null,
					cooldown: null,
					delay: null,
					triggers: [],
					extensions: {}
				}]);
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: TavernView_module_css_default.editor,
				style: { maxWidth: "none" },
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: TavernView_module_css_default.row,
						style: { justifyContent: "space-between" },
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: TavernView_module_css_default.row,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: TavernView_module_css_default.sectionTitle,
								style: {
									border: "none",
									padding: 0
								},
								children: props.book.name
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: TavernView_module_css_default.badge,
								children: [entries.length, " 条"]
							})]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: TavernView_module_css_default.row,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
								onClick: () => {
									const anchor = document.createElement("a");
									anchor.href = props.api.exportLorebookUrl(props.book.id);
									anchor.download = `${props.book.name}.json`;
									document.body.appendChild(anchor);
									anchor.click();
									anchor.remove();
								},
								children: "导出 JSON"
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
								variant: "danger",
								onClick: () => void props.onDelete(),
								children: "删除"
							})]
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
						label: "书名",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TextInput, {
							value: name,
							onChange: setName
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: TavernView_module_css_default.row,
						style: { justifyContent: "space-between" },
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: TavernView_module_css_default.sectionTitle,
							children: "条目"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
							onClick: addEntry,
							children: "＋ 新条目"
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: TavernView_module_css_default.entryList,
						children: [entries.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Empty, { text: "还没有条目" }), entries.map((entry, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: TavernView_module_css_default.entry,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: TavernView_module_css_default.entryHead,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										className: TavernView_module_css_default.entryKeys,
										children: ["关键词：", (entry.key ?? []).join("、") || "（无）"]
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
										variant: "ghost",
										onClick: () => setEntries((prev) => prev.filter((_, i) => i !== index)),
										children: "删除"
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
									label: "关键词（逗号分隔）",
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TextInput, {
										value: (entry.key ?? []).join(", "),
										onChange: (value) => updateEntry(index, { key: value.split(",").map((s) => s.trim()).filter((s) => s !== "") })
									})
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
									label: "内容",
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TextArea, {
										value: entry.content,
										onChange: (value) => updateEntry(index, { content: value }),
										rows: 3
									})
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: TavernView_module_css_default.row,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
										className: TavernView_module_css_default.checkRow,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											type: "checkbox",
											checked: entry.constant,
											onChange: (event) => updateEntry(index, { constant: event.target.checked })
										}), "常驻"]
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
										className: TavernView_module_css_default.checkRow,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											type: "checkbox",
											checked: !entry.disable,
											onChange: (event) => updateEntry(index, { disable: !event.target.checked })
										}), "启用"]
									})]
								})
							]
						}, entry.uid))]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: TavernView_module_css_default.row,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
							variant: "primary",
							disabled: saving,
							onClick: () => void save(),
							children: saving ? "保存中…" : "保存世界书"
						})
					})
				]
			});
		}
		//#endregion
		//#region src/client/components/PresetPanel.tsx
		/**
		* Preset panel: preset list, sampler editor, import/export.
		*/
		function PresetPanel(props) {
			const selected = props.presets.find((preset) => preset.id === props.selectedId) ?? null;
			const [importText, setImportText] = (0, react.useState)("");
			const [newName, setNewName] = (0, react.useState)("");
			const importPreset = async (text) => {
				try {
					const raw = JSON.parse(text);
					await props.api.createPreset({
						preset: raw,
						name: newName.trim() || void 0
					});
					setImportText("");
					setNewName("");
					await props.onChanged();
				} catch (error) {
					props.onError(error instanceof Error ? error.message : String(error));
				}
			};
			const deleteSelected = async () => {
				if (selected === null) return;
				if (!confirmAction(`删除预设「${selected.name}」？`)) return;
				await props.api.deletePreset(selected.id);
				props.onSelect(null);
				await props.onChanged();
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: TavernView_module_css_default.body,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: TavernView_module_css_default.sidebar,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: TavernView_module_css_default.sidebarHead,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: TavernView_module_css_default.sidebarTitle,
							children: [
								"预设（",
								props.presets.length,
								"）"
							]
						})
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: TavernView_module_css_default.list,
						children: [props.presets.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Empty, { text: "还没有预设" }), props.presets.map((preset) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: `${TavernView_module_css_default.listItem} ${preset.id === props.selectedId ? TavernView_module_css_default.listItemActive : ""}`,
							onClick: () => props.onSelect(preset.id),
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: TavernView_module_css_default.listItemName,
								children: [preset.name, preset.id === props.defaultPresetId ? " ★" : ""]
							})
						}, preset.id))]
					})]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: TavernView_module_css_default.content,
					children: selected === null ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: TavernView_module_css_default.section,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: TavernView_module_css_default.sectionTitle,
								children: "导入预设"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: TavernView_module_css_default.hint,
								children: "支持 SillyTavern / TauriTavern 预设 JSON（OpenAI / TextGen / Kobold 等类型均可）。 采样参数（温度、top_p、重复惩罚等）与模型路由会在生成时应用。"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
								label: "预设名（可选，留空用 JSON 内 name）",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TextInput, {
									value: newName,
									onChange: setNewName,
									placeholder: "例如：角色扮演-创意"
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
								label: "预设 JSON",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TextArea, {
									value: importText,
									onChange: setImportText,
									rows: 8,
									placeholder: "{\"temp\": 1.1, \"top_p\": 0.95, \"rep_pen\": 1.08, …}"
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: TavernView_module_css_default.row,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
									variant: "primary",
									disabled: importText.trim() === "",
									onClick: () => void importPreset(importText),
									children: "导入"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
									onClick: () => {
										const input = document.createElement("input");
										input.type = "file";
										input.accept = ".json,application/json";
										input.onchange = () => {
											const file = input.files?.[0];
											if (file !== void 0) fileToText(file).then((text) => importPreset(text)).catch((error) => {
												props.onError(error instanceof Error ? error.message : String(error));
											});
										};
										input.click();
									},
									children: "选择文件"
								})]
							})
						]
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(PresetEditor, {
						api: props.api,
						preset: selected,
						isDefault: selected.id === props.defaultPresetId,
						onChanged: props.onChanged,
						onError: props.onError,
						onDelete: deleteSelected
					})
				})]
			});
		}
		function numberField(value) {
			return value === void 0 ? "" : String(value);
		}
		function parseNumber(text) {
			if (text.trim() === "") return null;
			const value = Number(text);
			return Number.isFinite(value) ? value : void 0;
		}
		function PresetEditor(props) {
			const preset = props.preset;
			const [name, setName] = (0, react.useState)(preset.name);
			const [model, setModel] = (0, react.useState)(preset.model ?? "");
			const [provider, setProvider] = (0, react.useState)(preset.provider ?? "");
			const [maxTokens, setMaxTokens] = (0, react.useState)(numberField(preset.maxTokens));
			const [temperature, setTemperature] = (0, react.useState)(numberField(preset.temperature));
			const [topP, setTopP] = (0, react.useState)(numberField(preset.topP));
			const [topK, setTopK] = (0, react.useState)(numberField(preset.topK));
			const [topA, setTopA] = (0, react.useState)(numberField(preset.topA));
			const [typicalP, setTypicalP] = (0, react.useState)(numberField(preset.typicalP));
			const [minP, setMinP] = (0, react.useState)(numberField(preset.minP));
			const [repPen, setRepPen] = (0, react.useState)(numberField(preset.repPen));
			const [repPenRange, setRepPenRange] = (0, react.useState)(numberField(preset.repPenRange));
			const [repPenSlope, setRepPenSlope] = (0, react.useState)(numberField(preset.repPenSlope));
			const [presencePenalty, setPresencePenalty] = (0, react.useState)(numberField(preset.presencePenalty));
			const [frequencyPenalty, setFrequencyPenalty] = (0, react.useState)(numberField(preset.frequencyPenalty));
			const [systemPrompt, setSystemPrompt] = (0, react.useState)(preset.systemPrompt ?? "");
			const [saving, setSaving] = (0, react.useState)(false);
			const save = async () => {
				setSaving(true);
				try {
					await props.api.updatePreset(preset.id, {
						name: name.trim() || preset.name,
						model: model.trim() === "" ? null : model.trim(),
						provider: provider.trim() === "" ? null : provider.trim(),
						maxTokens: parseNumber(maxTokens),
						temperature: parseNumber(temperature),
						topP: parseNumber(topP),
						topK: parseNumber(topK),
						topA: parseNumber(topA),
						typicalP: parseNumber(typicalP),
						minP: parseNumber(minP),
						repPen: parseNumber(repPen),
						repPenRange: parseNumber(repPenRange),
						repPenSlope: parseNumber(repPenSlope),
						presencePenalty: parseNumber(presencePenalty),
						frequencyPenalty: parseNumber(frequencyPenalty),
						systemPrompt
					});
					await props.onChanged();
				} catch (error) {
					props.onError(error instanceof Error ? error.message : String(error));
				} finally {
					setSaving(false);
				}
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: TavernView_module_css_default.editor,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: TavernView_module_css_default.row,
						style: { justifyContent: "space-between" },
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: TavernView_module_css_default.row,
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: TavernView_module_css_default.sectionTitle,
								style: {
									border: "none",
									padding: 0
								},
								children: [
									preset.name,
									" ",
									props.isDefault ? "（默认）" : ""
								]
							})
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: TavernView_module_css_default.row,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
								onClick: () => {
									const anchor = document.createElement("a");
									anchor.href = props.api.exportPresetUrl(preset.id);
									anchor.download = `${preset.name}.json`;
									document.body.appendChild(anchor);
									anchor.click();
									anchor.remove();
								},
								children: "导出 JSON"
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
								variant: "danger",
								onClick: () => void props.onDelete(),
								children: "删除"
							})]
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: TavernView_module_css_default.row,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
								label: "名称",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TextInput, {
									value: name,
									onChange: setName
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
								label: "模型（custom_model）",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TextInput, {
									value: model,
									onChange: setModel,
									placeholder: "例如 deepseek-chat"
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
								label: "Provider（DSH 路由）",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TextInput, {
									value: provider,
									onChange: setProvider,
									placeholder: "留空用默认"
								})
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: TavernView_module_css_default.sectionTitle,
						children: "采样参数"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: TavernView_module_css_default.row,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
								label: "温度 temp",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TextInput, {
									value: temperature,
									onChange: setTemperature,
									placeholder: "1.0"
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
								label: "top_p",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TextInput, {
									value: topP,
									onChange: setTopP,
									placeholder: "0.95"
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
								label: "top_k",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TextInput, {
									value: topK,
									onChange: setTopK,
									placeholder: "0"
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
								label: "top_a",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TextInput, {
									value: topA,
									onChange: setTopA,
									placeholder: "0"
								})
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: TavernView_module_css_default.row,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
								label: "typical_p",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TextInput, {
									value: typicalP,
									onChange: setTypicalP,
									placeholder: "1"
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
								label: "min_p",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TextInput, {
									value: minP,
									onChange: setMinP,
									placeholder: "0"
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
								label: "重复惩罚 rep_pen",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TextInput, {
									value: repPen,
									onChange: setRepPen,
									placeholder: "1.08"
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
								label: "rep_pen_range",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TextInput, {
									value: repPenRange,
									onChange: setRepPenRange,
									placeholder: "1024"
								})
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: TavernView_module_css_default.row,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
								label: "rep_pen_slope",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TextInput, {
									value: repPenSlope,
									onChange: setRepPenSlope,
									placeholder: "0.7"
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
								label: "存在惩罚",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TextInput, {
									value: presencePenalty,
									onChange: setPresencePenalty,
									placeholder: "0"
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
								label: "频率惩罚",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TextInput, {
									value: frequencyPenalty,
									onChange: setFrequencyPenalty,
									placeholder: "0"
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
								label: "max_tokens",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TextInput, {
									value: maxTokens,
									onChange: setMaxTokens,
									placeholder: "模型默认"
								})
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
						label: "系统提示覆盖（叠加在角色卡之上）",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TextArea, {
							value: systemPrompt,
							onChange: setSystemPrompt,
							rows: 3
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: TavernView_module_css_default.row,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
							variant: "primary",
							disabled: saving,
							onClick: () => void save(),
							children: saving ? "保存中…" : "保存预设"
						})
					})
				]
			});
		}
		//#endregion
		//#region src/client/components/TauriTavernImportPanel.tsx
		/**
		* Local TauriTavern import panel: points the host plugin at a local
		* TauriTavern installation/data directory and batch-imports the tavern
		* categories it manages (characters, world books, presets).
		*/
		function TauriTavernImportPanel(props) {
			const [path, setPath] = (0, react.useState)("E:\\TauriTavern");
			const [characters, setCharacters] = (0, react.useState)(true);
			const [lorebooks, setLorebooks] = (0, react.useState)(true);
			const [presets, setPresets] = (0, react.useState)(true);
			const [running, setRunning] = (0, react.useState)(false);
			const [report, setReport] = (0, react.useState)(null);
			const startImport = async () => {
				if (path.trim() === "" || running) return;
				setRunning(true);
				setReport(null);
				try {
					const result = await props.api.importTauriTavern({
						path: path.trim(),
						characters,
						lorebooks,
						presets
					});
					setReport(result);
					await props.onChanged();
					props.onError(null);
				} catch (error) {
					props.onError(error instanceof Error ? error.message : String(error));
				} finally {
					setRunning(false);
				}
			};
			const total = report === null ? 0 : report.imported.characters + report.imported.lorebooks + report.imported.presets;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: TavernView_module_css_default.content,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: TavernView_module_css_default.editor,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: TavernView_module_css_default.sectionTitle,
							children: "从本地 TauriTavern 目录导入"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: TavernView_module_css_default.hint,
							children: "读取 DSH 进程所在机器上的原始 TauriTavern 数据目录（不会修改原目录）。 可填写安装目录、data 目录、default-user 目录，或其下任意子目录。"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
							label: "TauriTavern 安装 / 数据目录",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TextInput, {
								value: path,
								onChange: setPath,
								placeholder: "例如 E:\\TauriTavern 或 E:\\TauriTavern\\data\\default-user",
								disabled: running
							})
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: TavernView_module_css_default.row,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Checkbox, {
									checked: characters,
									onChange: setCharacters,
									label: "人物卡（characters/*.png、*.json）"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Checkbox, {
									checked: lorebooks,
									onChange: setLorebooks,
									label: "世界书（worlds/*.json）"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Checkbox, {
									checked: presets,
									onChange: setPresets,
									label: "预设（context / instruct / textgen 等）"
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: TavernView_module_css_default.row,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
								variant: "primary",
								disabled: running || path.trim() === "" || !characters && !lorebooks && !presets,
								onClick: () => void startImport(),
								children: running ? "导入中…" : "开始导入"
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: TavernView_module_css_default.hint,
								children: "数据会追加到酒馆对应资料库；重复执行会自动跳过已导入的同源数据。"
							})]
						}),
						report === null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Empty, { text: "尚未从本地目录导入" }) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: TavernView_module_css_default.section,
							style: { gap: 8 },
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: TavernView_module_css_default.sectionTitle,
									style: {
										border: "none",
										padding: 0
									},
									children: [
										"导入完成：共 ",
										total,
										" 条"
									]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: TavernView_module_css_default.hint,
									children: ["识别目录：", report.userDir]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: TavernView_module_css_default.hint,
									children: [
										"人物卡 ",
										report.imported.characters,
										" · 世界书 ",
										report.imported.lorebooks,
										" · 预设 ",
										report.imported.presets
									]
								}),
								report.issues.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: TavernView_module_css_default.entryList,
									children: report.issues.map((issue, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: TavernView_module_css_default.entry,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											className: TavernView_module_css_default.entryHead,
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
												className: TavernView_module_css_default.entryKeys,
												children: [
													issue.category,
													" / ",
													issue.file
												]
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: TavernView_module_css_default.hint,
												children: "跳过"
											})]
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: TavernView_module_css_default.entryContent,
											children: issue.reason
										})]
									}, `${issue.file}-${index}`))
								})
							]
						})
					]
				})
			});
		}
		//#endregion
		//#region src/client/TavernView.tsx
		/**
		* Tavern view: the conversation-view entry the tavern plugin registers.
		* The chat area renders the ACTIVE play's DSH session (the director
		* session) directly from its client runtime snapshot, without switching the
		* global current session, and sends through that session's conversation
		* service; the library panels manage characters / world books / presets
		* through the host route.
		*/
		/** Extract text blocks from a content block list. */
		function blocksToText(blocks) {
			return blocks.filter((block) => block.type === "text" && typeof block.text === "string").map((block) => block.text).join("");
		}
		/** Project ordered user/assistant rows from the session snapshot. */
		function extractMessages(snapshot, characterNames) {
			const out = [];
			for (const key of snapshot.chat.order) {
				const node = snapshot.chat.nodes.get(key);
				if (node === void 0) continue;
				const data = node.data;
				if (node.kind === "user") {
					const text = blocksToText(data.content ?? []).trim();
					if (text !== "" && text !== "[开场] 扮演开始。") out.push({
						id: key,
						kind: "user",
						text
					});
				} else if (node.kind === "assistant-step") {
					const trimmed = (data.blocks ?? []).filter((block) => block.kind === "text" && typeof block.text === "string").map((block) => block.text).join("").trim();
					if (trimmed === "") continue;
					const match = /^([^：:]{1,20})[：:]\s*([\s\S]+)$/.exec(trimmed);
					const name = match !== null && characterNames.includes(match[1].trim()) ? match[1].trim() : void 0;
					out.push({
						id: key,
						kind: "assistant",
						...name !== void 0 ? { name } : {},
						text: name !== void 0 ? match[2].trim() : trimmed
					});
				}
			}
			return out;
		}
		/** Load the full tavern state snapshot. */
		async function loadState(api) {
			return api.state();
		}
		/** Subscribe to an arbitrary session snapshot without making it the global current session. */
		function useSessionSnapshot(session) {
			return (0, react.useSyncExternalStore)((0, react.useCallback)((onStoreChange) => session?.subscribe(onStoreChange) ?? (() => {}), [session]), (0, react.useCallback)(() => session?.getSnapshot(), [session]));
		}
		function TavernView({ useStore, actions, useSessions, getSession, getConversation }) {
			const panel = useStore((s) => s.panel);
			const playId = useStore((s) => s.playId);
			const selectedCharacterId = useStore((s) => s.selectedCharacterId);
			const selectedLorebookId = useStore((s) => s.selectedLorebookId);
			const selectedPresetId = useStore((s) => s.selectedPresetId);
			const error = useStore((s) => s.error);
			const [state, setState] = (0, react.useState)(null);
			const [loading, setLoading] = (0, react.useState)(true);
			const rootRef = (0, react.useRef)(null);
			const [style, setStyle] = (0, react.useState)("dsh");
			const currentSessionId = useSessions((s) => s.current);
			const sessionIds = useSessions((s) => s.ids);
			const refresh = (0, react.useCallback)(async () => {
				const next = await loadState(tavernApi);
				setState(next);
				setLoading(false);
			}, []);
			(0, react.useEffect)(() => {
				refresh().catch((e) => {
					actions.setError(e instanceof Error ? e.message : String(e));
					setLoading(false);
				});
			}, [refresh, actions]);
			(0, react.useEffect)(() => {
				if (state?.style !== void 0) setStyle(state.style);
			}, [state?.style]);
			const changeStyle = (0, react.useCallback)((next) => {
				setStyle(next);
				tavernApi.setStyle(next).catch((e) => {
					actions.setError(e instanceof Error ? e.message : String(e));
				});
			}, [actions]);
			const selectPlay = (0, react.useCallback)((id) => {
				actions.setPlayId(id);
				actions.setPanel("chat");
				const playSummary = state?.plays.find((p) => p.id === id);
				if (playSummary !== void 0) tavernApi.activatePlay(playSummary.id).catch((e) => {
					actions.setError(e instanceof Error ? e.message : String(e));
				});
			}, [actions, state]);
			const createPlay = (0, react.useCallback)(async (title, characterIds, lorebookIds, presetId, narratorEnabled, multiAgent) => {
				try {
					const created = await tavernApi.createPlay({
						title,
						characterIds,
						lorebookIds,
						presetId,
						narratorEnabled,
						multiAgent
					});
					await refresh();
					actions.setPlayId(created.id);
					actions.setPanel("chat");
				} catch (e) {
					actions.setError(e instanceof Error ? e.message : String(e));
					throw e;
				}
			}, [actions, refresh]);
			const deletePlay = (0, react.useCallback)(async (id) => {
				try {
					await tavernApi.deletePlay(id);
					if (playId === id) actions.setPlayId(null);
					await refresh();
				} catch (e) {
					actions.setError(e instanceof Error ? e.message : String(e));
				}
			}, [
				actions,
				playId,
				refresh
			]);
			const characterNames = (0, react.useMemo)(() => state?.characters.map((c) => c.card.data.name) ?? [], [state]);
			const activePlay = playId !== null ? state?.plays.find((p) => p.id === playId) ?? null : null;
			const activeSession = (0, react.useMemo)(() => activePlay === null ? void 0 : getSession(activePlay.sessionId), [
				activePlay,
				getSession,
				sessionIds
			]);
			const activeSnapshot = useSessionSnapshot(activeSession);
			const activeSessionId = activeSession?.sessionId;
			const displaySessionId = activeSessionId ?? currentSessionId;
			(0, react.useEffect)(() => {
				if (activeSession === void 0) return;
				activeSession.open().catch((e) => {
					actions.setError(e instanceof Error ? e.message : String(e));
				});
			}, [activeSession, actions]);
			(0, react.useLayoutEffect)(() => {
				const seat = (rootRef.current?.closest("[data-conversation-scroll]"))?.querySelector("[data-composer-seat]") ?? document.querySelector("[data-composer-seat]");
				if (seat === null || seat === void 0) return;
				const startHeight = seat.getBoundingClientRect().height;
				if (startHeight <= 0) return;
				const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
				const previousStyles = {
					maxHeight: seat.style.maxHeight,
					opacity: seat.style.opacity,
					transform: seat.style.transform,
					visibility: seat.style.visibility,
					overflow: seat.style.overflow,
					pointerEvents: seat.style.pointerEvents
				};
				const restore = () => {
					seat.style.maxHeight = previousStyles.maxHeight;
					seat.style.opacity = previousStyles.opacity;
					seat.style.transform = previousStyles.transform;
					seat.style.visibility = previousStyles.visibility;
					seat.style.overflow = previousStyles.overflow;
					seat.style.pointerEvents = previousStyles.pointerEvents;
				};
				if (typeof seat.animate !== "function") {
					seat.style.maxHeight = "0px";
					seat.style.opacity = "0";
					seat.style.transform = "translateY(8px)";
					seat.style.visibility = "hidden";
					seat.style.overflow = "hidden";
					seat.style.pointerEvents = "none";
					return restore;
				}
				seat.style.overflow = "hidden";
				seat.style.pointerEvents = "none";
				const animation = seat.animate([{
					maxHeight: `${startHeight}px`,
					opacity: "1",
					transform: "translateY(0)"
				}, {
					maxHeight: "0px",
					opacity: "0",
					transform: "translateY(8px)"
				}], {
					duration: reduceMotion ? 0 : 200,
					easing: "ease",
					fill: "forwards"
				});
				return () => {
					animation.cancel();
					restore();
				};
			}, []);
			const messages = (0, react.useMemo)(() => activeSnapshot === void 0 ? [] : extractMessages(activeSnapshot, characterNames), [activeSnapshot, characterNames]);
			const running = activeSnapshot !== void 0 && (activeSnapshot.chat.legacy.runningCalls.length > 0 || activeSnapshot.queue.length > 0);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				ref: rootRef,
				className: TavernView_module_css_default.view,
				"data-style": style,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: TavernView_module_css_default.nav,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: TavernView_module_css_default.navTitle,
							children: "🏮 酒馆"
						}),
						[
							["chat", "会话"],
							["characters", "角色"],
							["lorebooks", "世界书"],
							["presets", "预设"],
							["import", "导入"]
						].map(([key, label]) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: `${TavernView_module_css_default.navTab} ${panel === key ? TavernView_module_css_default.navTabActive : ""}`,
							onClick: () => actions.setPanel(key),
							children: label
						}, key)),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: TavernView_module_css_default.navSpacer }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
							className: TavernView_module_css_default.stylePicker,
							title: "切换酒馆样式（跟随 DSH 主题或经典暗金）",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "样式" }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
								className: TavernView_module_css_default.styleSelect,
								value: style,
								onChange: (event) => changeStyle(event.target.value),
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "dsh",
									children: "跟随 DSH"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "classic",
									children: "经典酒馆"
								})]
							})]
						}),
						error !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: TavernView_module_css_default.navError,
							title: error,
							children: ["⚠ ", error]
						}),
						!loading && state !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: TavernView_module_css_default.hint,
							style: { marginRight: 8 },
							children: ["会话 ", displaySessionId !== void 0 ? displaySessionId.slice(0, 12) : "（无）"]
						})
					]
				}), loading ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: TavernView_module_css_default.content,
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Empty, { text: "正在加载酒馆…" })
				}) : state === null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: TavernView_module_css_default.content,
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Empty, { text: "酒馆数据不可用" })
				}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: TavernView_module_css_default.body,
					style: { border: "none" },
					children: [
						panel === "chat" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ChatPanel, {
							api: tavernApi,
							plays: state.plays,
							characters: state.characters.map((c) => ({
								id: c.id,
								name: c.card.data.name,
								avatar: c.avatar,
								description: c.card.data.description,
								personality: c.card.data.personality,
								tags: c.card.data.tags
							})),
							lorebooks: state.lorebooks.map((b) => ({
								id: b.id,
								name: b.name,
								description: b.book.description,
								entryCount: b.book.entries.length
							})),
							presets: state.presets.map((p) => ({
								id: p.id,
								name: p.name
							})),
							activePlayId: playId,
							activePlayTitle: activePlay?.title,
							multiAgentAvailable: state.multiAgentAvailable,
							messages,
							activeSessionId,
							running,
							onSelectPlay: selectPlay,
							onGoToCharacters: () => actions.setPanel("characters"),
							onGoToLorebooks: () => actions.setPanel("lorebooks"),
							onCreatePlay: createPlay,
							onDeletePlay: deletePlay,
							onSend: async (text) => {
								actions.setError(null);
								try {
									if (activePlay === null || activeSession === void 0) throw new Error("请先选择一个酒馆会话");
									await getConversation(activeSession.sessionId).send(text);
								} catch (e) {
									actions.setError(e instanceof Error ? e.message : String(e));
								}
							}
						}),
						panel === "characters" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(CharacterPanel, {
							api: tavernApi,
							characters: state.characters,
							selectedId: selectedCharacterId,
							onSelect: actions.selectCharacter,
							onChanged: refresh,
							onError: actions.setError
						}),
						panel === "lorebooks" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(LorebookPanel, {
							api: tavernApi,
							lorebooks: state.lorebooks,
							selectedId: selectedLorebookId,
							onSelect: actions.selectLorebook,
							onChanged: refresh,
							onError: actions.setError
						}),
						panel === "presets" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(PresetPanel, {
							api: tavernApi,
							presets: state.presets,
							selectedId: selectedPresetId,
							defaultPresetId: state.defaultPresetId,
							onSelect: actions.selectPreset,
							onChanged: refresh,
							onError: actions.setError
						}),
						panel === "import" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TauriTavernImportPanel, {
							api: tavernApi,
							onChanged: refresh,
							onError: actions.setError
						})
					]
				})]
			});
		}
		//#endregion
		//#region src/client/index.ts
		/** Required services: the slot registry, the session manager, and the conversation service. */
		const inject = [
			"slots",
			"sessions",
			"conversation"
		];
		/** Resolve the session-scoped conversation face, failing loud. */
		function scopedConversation(sessions, id) {
			const scoped = sessions.scope(id);
			if (scoped === void 0) throw new Error(`dsh-tavern: session "${id}" resolved no scope`);
			const conversation = scoped.get("conversation");
			if (conversation === void 0) throw new Error("dsh-tavern: conversation service unavailable through the session scope");
			return conversation;
		}
		/**
		* Client plugin body: register the tavern view tab. The registration rides
		* the slot service's effect wrapper, so plugin unload removes the tab.
		* @param ctx - client root context.
		*/
		function apply(ctx) {
			const tavernStore = createTavernStore();
			const sessions = ctx.sessions;
			ctx.slots.inject("conversation.view", () => ctx.slots.register({
				name: "conversation.view",
				id: "tavern",
				order: 20,
				label: () => "酒馆",
				store: tavernStore,
				inject: (_sessionId) => {
					return {
						getSession: (id) => sessions.binding(id)?.session,
						getConversation: (id) => scopedConversation(sessions, id)
					};
				}
			}, TavernView));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map