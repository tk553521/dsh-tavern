import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import path, { join } from "node:path";
import zlib from "node:zlib";
import { promises } from "node:fs";
//#region src/storage.ts
const EMPTY_DATABASE = {
	version: 1,
	characters: [],
	lorebooks: [],
	presets: [],
	plays: []
};
/** Generate a reasonably unique local id. */
function newId(prefix) {
	const rand = Math.random().toString(36).slice(2, 10);
	return `${prefix}-${Date.now().toString(36)}-${rand}`;
}
/** Timestamp helper (ISO string). */
function nowIso() {
	return (/* @__PURE__ */ new Date()).toISOString();
}
/**
* Storage facade over the settings scope. Every mutation replaces whole
* arrays (the settings patch merges shallowly), so readers always see a
* consistent snapshot.
*/
var TavernStorage = class {
	scope;
	constructor(scope) {
		this.scope = scope;
	}
	snapshot() {
		return this.scope.get();
	}
	listCharacters() {
		return this.snapshot().characters;
	}
	getCharacter(id) {
		return this.snapshot().characters.find((c) => c.id === id);
	}
	async upsertCharacter(record) {
		const db = this.snapshot();
		const index = db.characters.findIndex((c) => c.id === record.id);
		const characters = [...db.characters];
		if (index >= 0) characters[index] = record;
		else characters.push(record);
		await this.scope.update({ characters });
	}
	/** Persist the complete character array (used by avatar-file migration). */
	async replaceCharacters(records) {
		await this.scope.update({ characters: records });
	}
	/** Bulk-append imported character records in a single settings write. */
	async appendCharacters(records) {
		if (records.length === 0) return;
		const db = this.snapshot();
		await this.scope.update({ characters: [...db.characters, ...records] });
	}
	async deleteCharacter(id) {
		const db = this.snapshot();
		await this.scope.update({
			characters: db.characters.filter((c) => c.id !== id),
			plays: db.plays.map((p) => p.characterIds.includes(id) ? {
				...p,
				characterIds: p.characterIds.filter((cid) => cid !== id)
			} : p)
		});
	}
	listLorebooks() {
		return this.snapshot().lorebooks;
	}
	getLorebook(id) {
		return this.snapshot().lorebooks.find((b) => b.id === id);
	}
	async upsertLorebook(record) {
		const db = this.snapshot();
		const index = db.lorebooks.findIndex((b) => b.id === record.id);
		const lorebooks = [...db.lorebooks];
		if (index >= 0) lorebooks[index] = record;
		else lorebooks.push(record);
		await this.scope.update({ lorebooks });
	}
	/** Bulk-append imported lorebook records in a single settings write. */
	async appendLorebooks(records) {
		if (records.length === 0) return;
		const db = this.snapshot();
		await this.scope.update({ lorebooks: [...db.lorebooks, ...records] });
	}
	async deleteLorebook(id) {
		const db = this.snapshot();
		await this.scope.update({
			lorebooks: db.lorebooks.filter((b) => b.id !== id),
			plays: db.plays.map((p) => {
				const next = { ...p };
				if (p.lorebookId === id) delete next.lorebookId;
				if (p.lorebookIds !== void 0) {
					const lorebookIds = p.lorebookIds.filter((bid) => bid !== id);
					if (lorebookIds.length > 0) next.lorebookIds = lorebookIds;
					else delete next.lorebookIds;
				}
				return next;
			})
		});
	}
	listPresets() {
		return this.snapshot().presets;
	}
	getPreset(id) {
		return this.snapshot().presets.find((p) => p.id === id);
	}
	async upsertPreset(preset) {
		const db = this.snapshot();
		const index = db.presets.findIndex((p) => p.id === preset.id);
		const presets = [...db.presets];
		if (index >= 0) presets[index] = preset;
		else presets.push(preset);
		await this.scope.update({ presets });
	}
	/** Bulk-append imported preset records in a single settings write. */
	async appendPresets(records) {
		if (records.length === 0) return;
		const db = this.snapshot();
		await this.scope.update({ presets: [...db.presets, ...records] });
	}
	async deletePreset(id) {
		const db = this.snapshot();
		await this.scope.update({
			presets: db.presets.filter((p) => p.id !== id),
			plays: db.plays.map((p) => p.presetId === id ? {
				...p,
				presetId: void 0
			} : p)
		});
	}
	listPlays() {
		return this.snapshot().plays;
	}
	getPlay(id) {
		return this.snapshot().plays.find((p) => p.id === id);
	}
	async upsertPlay(play) {
		const db = this.snapshot();
		const index = db.plays.findIndex((p) => p.id === play.id);
		const plays = [...db.plays];
		if (index >= 0) plays[index] = play;
		else plays.push(play);
		await this.scope.update({ plays });
	}
	async deletePlay(id) {
		const db = this.snapshot();
		await this.scope.update({ plays: db.plays.filter((p) => p.id !== id) });
	}
	async setDefaultPreset(id) {
		if (id === void 0) {
			await this.scope.replace({
				...this.snapshot(),
				defaultPresetId: void 0
			});
			return;
		}
		await this.scope.update({ defaultPresetId: id });
	}
	/** Persist the tavern view style preference. */
	async setStyle(style) {
		await this.scope.update({ style });
	}
};
//#endregion
//#region src/avatarstore.ts
/**
* Tavern avatar storage: character avatars are written as image files under
* `<dsh-home>/tavern/avatars/`, while the settings document stores only the
* short relative path (`tavern/avatars/<character-id>.png`).  Legacy data URLs
* are migrated off the settings document on startup and whenever a character
* is created/updated/imported.
*/
/** Directory prefix persisted in `character.avatar` (portable, `/`-separated). */
const AVATAR_DIR_RELATIVE = "tavern/avatars";
const SAFE_FILE_RE = /^[a-zA-Z0-9_-]+\.(?:png|jpg|jpeg|webp|gif)$/i;
const DATA_URL_RE = /^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,([A-Za-z0-9+/=\r\n]+)$/i;
const MIME_TYPES = {
	"image/png": "image/png",
	"image/jpeg": "image/jpeg",
	"image/jpg": "image/jpeg",
	"image/webp": "image/webp",
	"image/gif": "image/gif"
};
function extensionForMime(mime) {
	return mime === "image/jpeg" || mime === "image/jpg" ? "jpg" : mime.slice(6);
}
function decodeDataUrl(value) {
	const match = DATA_URL_RE.exec(value.trim());
	if (match === null || match[1] === void 0 || match[2] === void 0) return void 0;
	const mime = match[1].toLowerCase();
	const bytes = Buffer.from(match[2], "base64");
	if (bytes.length === 0) return void 0;
	return {
		bytes,
		mime,
		extension: extensionForMime(mime)
	};
}
function safeFile(id, extension) {
	if (!/^[a-zA-Z0-9_-]+$/.test(id)) return void 0;
	return `${id}.${extension}`;
}
function relativeAvatar(file) {
	return `${AVATAR_DIR_RELATIVE}/${file}`;
}
function fileFromAvatar(avatar) {
	if (avatar === void 0) return void 0;
	const normalized = avatar.replace(/\\/g, "/");
	if (!normalized.startsWith(`tavern/avatars/`)) return void 0;
	const file = normalized.slice(15).split("/").pop() ?? "";
	return SAFE_FILE_RE.test(file) ? file : void 0;
}
/**
* File-backed avatar store.  Persisted paths are always relative to the DSH
* home directory so the settings document stays host-independent.
*/
var AvatarStore = class {
	root;
	logger;
	constructor(root, logger) {
		this.root = root;
		this.logger = logger;
	}
	filePath(file) {
		return path.join(this.root, file);
	}
	async ensureRoot() {
		await mkdir(this.root, { recursive: true });
	}
	/**
	* Replace a character's data-URL avatar with an on-disk file and return the
	* record that should be persisted.  Records that already use a relative path
	* (or have no avatar) are returned unchanged.
	*/
	async materializeCharacter(record, previous) {
		const avatar = record.avatar;
		if (avatar === void 0 || !avatar.startsWith("data:")) return record;
		const decoded = decodeDataUrl(avatar);
		if (decoded === void 0) {
			this.logger.warn("tavern avatar: unsupported data URL for character %s; leaving it inline", record.id);
			return record;
		}
		const file = safeFile(record.id, decoded.extension);
		if (file === void 0) {
			this.logger.warn("tavern avatar: character id %s is not filename-safe; leaving avatar inline", record.id);
			return record;
		}
		await this.ensureRoot();
		await writeFile(this.filePath(file), decoded.bytes);
		const previousFile = previous !== void 0 ? fileFromAvatar(previous.avatar) : void 0;
		if (previousFile !== void 0 && previousFile.toLowerCase() !== file.toLowerCase()) await rm(this.filePath(previousFile), { force: true }).catch(() => void 0);
		return {
			...record,
			avatar: relativeAvatar(file)
		};
	}
	/** Materialize every data-URL avatar in one batch (used by the importer). */
	async materializeCharacters(records) {
		return Promise.all(records.map((record) => this.materializeCharacter(record)));
	}
	/**
	* Migrate legacy inline avatars out of the settings document.  A failed file
	* write keeps the original data URL, so a migration is always safe to retry.
	*/
	async migrateLegacyCharacters(records) {
		const characters = [];
		let changed = 0;
		for (const record of records) try {
			const next = await this.materializeCharacter(record, record);
			if (next.avatar !== record.avatar) changed += 1;
			characters.push(next);
		} catch (error) {
			this.logger.warn("tavern avatar: failed to migrate avatar for %s: %s", record.id, String(error));
			characters.push(record);
		}
		return {
			characters,
			changed
		};
	}
	/** Read a stored avatar for the HTTP route. */
	async read(file) {
		if (!SAFE_FILE_RE.test(file)) return void 0;
		try {
			const bytes = await readFile(this.filePath(file));
			const extension = file.split(".").pop()?.toLowerCase() ?? "png";
			return {
				bytes,
				contentType: MIME_TYPES[`image/${extension}`] ?? MIME_TYPES["image/png"]
			};
		} catch {
			return;
		}
	}
	/** Read the bytes backing a character record (legacy inline or on-disk). */
	async readCharacter(record) {
		const avatar = record.avatar;
		if (avatar === void 0) return void 0;
		if (avatar.startsWith("data:")) return decodeDataUrl(avatar)?.bytes;
		const file = fileFromAvatar(avatar);
		if (file === void 0) return void 0;
		return (await this.read(file))?.bytes;
	}
	/** Remove the on-disk avatar for a deleted character. */
	async removeCharacter(record) {
		const file = fileFromAvatar(record.avatar);
		if (file === void 0) return;
		await rm(this.filePath(file), { force: true }).catch(() => void 0);
	}
};
//#endregion
//#region src/png.ts
/**
* PNG character-card parsing and encoding (SillyTavern/TauriTavern
* convention): the card JSON is Base64(UTF-8(JSON)) stored in a PNG text
* chunk. Keyword priority: `ccv3` (v3 cards) wins over `chara` (v2 cards).
* tEXt is the standard carrier; zTXt/iTXt are tolerated for robustness.
*/
const PNG_SIGNATURE = Buffer.from([
	137,
	80,
	78,
	71,
	13,
	10,
	26,
	10
]);
const CHARA_KEYWORD = "chara";
const CCV3_KEYWORD = "ccv3";
function isTextChunk(type) {
	return type === "tEXt" || type === "zTXt" || type === "iTXt";
}
/** Read one complete PNG chunk at `offset`, or null when truncated. */
function chunkAt(buffer, offset) {
	if (offset + 8 > buffer.length) return null;
	const length = buffer.readUInt32BE(offset);
	const dataStart = offset + 8;
	const dataEnd = dataStart + length;
	if (dataEnd + 4 > buffer.length) return null;
	return {
		type: buffer.subarray(offset + 4, offset + 8).toString("ascii"),
		data: buffer.subarray(dataStart, dataEnd),
		raw: buffer.subarray(offset, dataEnd + 4)
	};
}
/** Parse the character card JSON out of a PNG buffer. */
function parsePngCard(buffer) {
	if (buffer.length < PNG_SIGNATURE.length || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
	const imageChunks = [];
	let ended = false;
	let offset = 8;
	let charaText;
	let ccv3Text;
	while (true) {
		const current = chunkAt(buffer, offset);
		if (current === null) break;
		if (!ended) {
			if (!isTextChunk(current.type)) imageChunks.push(current.raw);
			if (current.type === "IEND") ended = true;
		}
		if (isTextChunk(current.type)) {
			const text = parseTextChunk(current.type, current.data);
			if (text !== null) {
				if (text.keyword.toLowerCase() === CCV3_KEYWORD) ccv3Text = decodeCardText(text.text);
				else if (text.keyword.toLowerCase() === CHARA_KEYWORD && charaText === void 0) charaText = decodeCardText(text.text);
			}
		}
		offset += current.raw.length;
	}
	const json = ccv3Text ?? charaText;
	if (json === void 0) return null;
	return {
		json,
		avatar: ended && imageChunks.length > 0 ? Buffer.concat([PNG_SIGNATURE, ...imageChunks]) : void 0
	};
}
function parseTextChunk(type, data) {
	const nul = data.indexOf(0);
	if (nul < 0) return null;
	const keyword = data.subarray(0, nul).toString("latin1");
	const payload = data.subarray(nul + 1);
	try {
		if (type === "tEXt") return {
			keyword,
			text: payload.toString("latin1")
		};
		if (type === "zTXt") {
			if (payload.length < 1 || payload[0] !== 0) return null;
			const compressed = payload.subarray(1);
			return {
				keyword,
				text: zlib.inflateSync(compressed).toString("utf8")
			};
		}
		if (type === "iTXt") {
			const compressionFlag = payload[0];
			const langNul = payload.indexOf(0, 2);
			if (langNul < 0) return null;
			const keyNul = payload.indexOf(0, langNul + 1);
			if (keyNul < 0) return null;
			const raw = payload.subarray(keyNul + 1);
			return {
				keyword,
				text: compressionFlag === 1 ? zlib.inflateSync(raw).toString("utf8") : raw.toString("utf8")
			};
		}
	} catch {
		return null;
	}
	return null;
}
function decodeCardText(raw) {
	const trimmed = raw.trim();
	if (trimmed === "") return void 0;
	try {
		const decoded = Buffer.from(trimmed, "base64").toString("utf8");
		if (decoded.trimStart().startsWith("{")) return decoded;
	} catch {}
	if (trimmed.startsWith("{")) return trimmed;
}
const CRC_TABLE = (() => {
	const table = /* @__PURE__ */ new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 3988292384 ^ c >>> 1 : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();
function crc32(buffer) {
	let crc = 4294967295;
	for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 255] ^ crc >>> 8;
	return (crc ^ 4294967295) >>> 0;
}
/** Append one PNG chunk (length + type + data + CRC). */
function chunk(type, data) {
	const typeBuf = Buffer.from(type, "ascii");
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
	return Buffer.concat([
		length,
		typeBuf,
		data,
		crc
	]);
}
/** Extract image chunks (IHDR..IEND, no text chunks) from an avatar PNG. */
function imageChunks(avatar) {
	if (avatar.length < PNG_SIGNATURE.length || !avatar.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
	const chunks = [];
	let offset = 8;
	let ended = false;
	while (true) {
		const current = chunkAt(avatar, offset);
		if (current === null) break;
		if (current.type === "IEND") {
			chunks.push(current);
			ended = true;
			break;
		}
		if (!isTextChunk(current.type)) chunks.push(current);
		offset += current.raw.length;
	}
	if (!ended) chunks.push({
		type: "IEND",
		data: Buffer.alloc(0),
		raw: chunk("IEND", Buffer.alloc(0))
	});
	if (chunks[0]?.type !== "IHDR" || !chunks.some((c) => c.type === "IDAT")) return null;
	return chunks;
}
/** A minimal 1x1 transparent PNG chunk list. */
function blankPngChunks() {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(1, 0);
	ihdr.writeUInt32BE(1, 4);
	ihdr[8] = 8;
	ihdr[9] = 6;
	const idat = zlib.deflateSync(Buffer.from([
		0,
		0,
		0,
		0,
		0
	]));
	return [
		{
			type: "IHDR",
			data: ihdr,
			raw: chunk("IHDR", ihdr)
		},
		{
			type: "IDAT",
			data: idat,
			raw: chunk("IDAT", idat)
		},
		{
			type: "IEND",
			data: Buffer.alloc(0),
			raw: chunk("IEND", Buffer.alloc(0))
		}
	];
}
/**
* Build a PNG carrying the card JSON in a tEXt chunk (Base64-encoded value,
* keyword `chara`). The text chunk is inserted BEFORE IEND, as PNG requires.
* When `avatar` is a PNG buffer its image chunks are reused; otherwise a 1x1
* transparent PNG is emitted.
*/
function encodePngCard(json, avatar) {
	const chunks = avatar !== void 0 ? imageChunks(avatar) ?? blankPngChunks() : blankPngChunks();
	const textData = Buffer.concat([Buffer.from(`${CHARA_KEYWORD}\0`, "latin1"), Buffer.from(Buffer.from(json, "utf8").toString("base64"), "latin1")]);
	const textChunk = chunk("tEXt", textData);
	const iendIndex = chunks.findIndex((c) => c.type === "IEND");
	chunks.splice(iendIndex < 0 ? chunks.length : iendIndex, 0, {
		type: "tEXt",
		data: textData,
		raw: textChunk
	});
	return Buffer.concat([PNG_SIGNATURE, ...chunks.map((c) => c.raw)]);
}
//#endregion
//#region src/cardcodec.ts
const V2_REQUIRED = [
	"name",
	"description",
	"personality",
	"scenario",
	"first_mes",
	"mes_example",
	"creator_notes",
	"system_prompt",
	"post_history_instructions",
	"alternate_greetings",
	"tags",
	"creator",
	"character_version",
	"extensions"
];
/** Normalize raw card JSON (v1/v2/v3) into a canonical v2 card. */
function normalizeCard(raw, sourceName) {
	if (typeof raw !== "object" || raw === null) throw new Error("人物卡 JSON 无效：不是对象");
	const obj = raw;
	const dataRaw = (typeof obj.spec === "string" ? obj.spec : void 0) !== void 0 && typeof obj.data === "object" && obj.data !== null ? obj.data : obj;
	const data = {
		name: str(dataRaw.name),
		description: str(dataRaw.description),
		personality: str(dataRaw.personality),
		scenario: str(dataRaw.scenario),
		first_mes: str(dataRaw.first_mes),
		mes_example: str(dataRaw.mes_example),
		creator_notes: str(dataRaw.creator_notes),
		system_prompt: str(dataRaw.system_prompt),
		post_history_instructions: str(dataRaw.post_history_instructions),
		alternate_greetings: strArray(dataRaw.alternate_greetings),
		...Array.isArray(dataRaw.group_only_greetings) ? { group_only_greetings: strArray(dataRaw.group_only_greetings) } : {},
		...isWorldBookish(dataRaw.character_book) ? { character_book: normalizeWorldBook(dataRaw.character_book) } : {},
		tags: strArray(dataRaw.tags),
		creator: str(dataRaw.creator),
		character_version: str(dataRaw.character_version),
		extensions: typeof dataRaw.extensions === "object" && dataRaw.extensions !== null ? dataRaw.extensions : {}
	};
	for (const key of V2_REQUIRED) {
		const value = data[key];
		if (value === void 0) data[key] = Array.isArray(value) ? [] : key === "extensions" ? {} : "";
	}
	if (data.name.trim() === "") throw new Error(`人物卡缺少名称${sourceName !== void 0 ? `（${sourceName}）` : ""}`);
	return {
		spec: "chara_card_v2",
		spec_version: typeof obj.spec_version === "string" ? obj.spec_version : "2.0",
		data
	};
}
/** Parse a character card from JSON text or PNG bytes. */
function parseCardInput(input, sourceName) {
	if (typeof input === "string") return normalizeCard(JSON.parse(input), sourceName);
	const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
	const png = parsePngCard(buffer);
	if (png !== null) return normalizeCard(JSON.parse(png.json), sourceName);
	return normalizeCard(JSON.parse(buffer.toString("utf8")), sourceName);
}
/** Extract an avatar data URL from PNG bytes (or undefined). */
function avatarDataUrl(bytes) {
	const png = parsePngCard(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
	if (png?.avatar !== void 0) return `data:image/png;base64,${png.avatar.toString("base64")}`;
}
function isWorldBookish(value) {
	return typeof value === "object" && value !== null && "entries" in value;
}
const ENTRY_DEFAULTS = (uid) => ({
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
});
/** Convert one raw entry (ST top-level + snake_case extensions) to canonical form. */
function normalizeEntry(raw, uid) {
	const entry = ENTRY_DEFAULTS(uid);
	const ext = typeof raw.extensions === "object" && raw.extensions !== null ? raw.extensions : {};
	const pick = (top, snake) => {
		const value = raw[top];
		if (value !== void 0) return value;
		const mirrored = ext[snake];
		if (mirrored !== void 0) return mirrored;
	};
	const bool = (v, fallback) => typeof v === "boolean" ? v : fallback;
	const num = (v, fallback) => typeof v === "number" && Number.isFinite(v) ? v : fallback;
	const nullableNum = (v) => typeof v === "number" && Number.isFinite(v) ? v : null;
	entry.key = strArray(raw.key);
	entry.keysecondary = strArray(raw.keysecondary);
	entry.comment = str(raw.comment);
	entry.content = str(raw.content);
	entry.constant = bool(raw.constant, false);
	entry.vectorized = bool(pick("vectorized", "vectorized"), false);
	entry.selective = bool(raw.selective, true);
	entry.selectiveLogic = num(pick("selectiveLogic", "selectiveLogic"), 0);
	entry.addMemo = bool(raw.addMemo, false);
	entry.order = num(raw.order, 100);
	entry.position = num(pick("position", "position"), 0);
	entry.disable = bool(raw.disable, false);
	entry.ignoreBudget = bool(pick("ignoreBudget", "ignore_budget"), false);
	entry.excludeRecursion = bool(pick("excludeRecursion", "exclude_recursion"), false);
	entry.preventRecursion = bool(pick("preventRecursion", "prevent_recursion"), false);
	entry.matchPersonaDescription = bool(pick("matchPersonaDescription", "match_persona_description"), false);
	entry.matchCharacterDescription = bool(pick("matchCharacterDescription", "match_character_description"), false);
	entry.matchCharacterPersonality = bool(pick("matchCharacterPersonality", "match_character_personality"), false);
	entry.matchCharacterDepthPrompt = bool(pick("matchCharacterDepthPrompt", "match_character_depth_prompt"), false);
	entry.matchScenario = bool(pick("matchScenario", "match_scenario"), false);
	entry.matchCreatorNotes = bool(pick("matchCreatorNotes", "match_creator_notes"), false);
	entry.delayUntilRecursion = num(pick("delayUntilRecursion", "delay_until_recursion"), 0);
	entry.probability = num(pick("probability", "probability"), 100);
	entry.useProbability = bool(pick("useProbability", "useProbability"), true);
	entry.depth = num(pick("depth", "depth"), 4);
	entry.outletName = str(pick("outletName", "outlet_name"));
	entry.group = str(pick("group", "group"));
	entry.groupOverride = bool(pick("groupOverride", "group_override"), false);
	entry.groupWeight = num(pick("groupWeight", "group_weight"), 100);
	entry.scanDepth = nullableNum(pick("scanDepth", "scan_depth"));
	entry.caseSensitive = nullableNum(pick("caseSensitive", "case_sensitive")) === null ? null : bool(pick("caseSensitive", "case_sensitive"), false);
	entry.matchWholeWords = nullableNum(pick("matchWholeWords", "match_whole_words")) === null ? null : bool(pick("matchWholeWords", "match_whole_words"), false);
	entry.useGroupScoring = nullableNum(pick("useGroupScoring", "use_group_scoring")) === null ? null : bool(pick("useGroupScoring", "use_group_scoring"), false);
	entry.automationId = str(pick("automationId", "automation_id"));
	entry.role = num(pick("role", "role"), 0);
	entry.sticky = nullableNum(pick("sticky", "sticky"));
	entry.cooldown = nullableNum(pick("cooldown", "cooldown"));
	entry.delay = nullableNum(pick("delay", "delay"));
	entry.triggers = strArray(pick("triggers", "triggers"));
	entry.keyregex = typeof raw.keyregex === "string" ? raw.keyregex : void 0;
	entry.extensions = { ...ext };
	return entry;
}
/**
* Normalize a world book: accepts the ST uid-keyed object form
* `{ entries: { "0": {...}, ... } }`, the array form, and the embedded
* character_book form `{ entries: [...] }` (camelCase field names).
*/
function normalizeWorldBook(raw) {
	if (typeof raw !== "object" || raw === null) throw new Error("世界书 JSON 无效：不是对象");
	const obj = raw;
	const entriesRaw = obj.entries;
	let entries;
	if (Array.isArray(entriesRaw)) entries = entriesRaw.filter((item) => typeof item === "object" && item !== null).map((item, index) => {
		return normalizeEntry(item, typeof item.uid === "number" && Number.isSafeInteger(item.uid) ? item.uid : index);
	});
	else if (typeof entriesRaw === "object" && entriesRaw !== null) entries = Object.entries(entriesRaw).filter(([, item]) => typeof item === "object" && item !== null).map(([uid, item], index) => {
		const parsed = Number(uid);
		return normalizeEntry(item, Number.isSafeInteger(parsed) ? parsed : index);
	});
	else entries = [];
	return {
		...typeof obj.name === "string" ? { name: obj.name } : {},
		...typeof obj.description === "string" ? { description: obj.description } : {},
		...typeof obj.scan_depth === "number" ? { scan_depth: obj.scan_depth } : {},
		...typeof obj.token_budget === "number" ? { token_budget: obj.token_budget } : {},
		...typeof obj.recursive_scanning === "boolean" ? { recursive_scanning: obj.recursive_scanning } : {},
		...typeof obj.extensions === "object" && obj.extensions !== null ? { extensions: obj.extensions } : {},
		entries
	};
}
/** Serialize a tavern book into the ST world-info file form (uid-keyed object). */
function serializeWorldBookFile(book) {
	const entries = {};
	for (const entry of book.entries) entries[String(entry.uid)] = serializeEntry(entry);
	return {
		...book.name !== void 0 ? { name: book.name } : {},
		...book.description !== void 0 ? { description: book.description } : {},
		...book.scan_depth !== void 0 ? { scan_depth: book.scan_depth } : {},
		...book.token_budget !== void 0 ? { token_budget: book.token_budget } : {},
		...book.recursive_scanning !== void 0 ? { recursive_scanning: book.recursive_scanning } : {},
		...book.extensions !== void 0 ? { extensions: book.extensions } : {},
		entries
	};
}
/** Serialize one entry back to the ST top-level + extensions form. */
function serializeEntry(entry) {
	const ext = {
		...entry.extensions,
		position: entry.position,
		exclude_recursion: entry.excludeRecursion,
		display_index: entry.order,
		probability: entry.probability,
		useProbability: entry.useProbability,
		depth: entry.depth,
		selectiveLogic: entry.selectiveLogic,
		outlet_name: entry.outletName,
		group: entry.group,
		group_override: entry.groupOverride,
		group_weight: entry.groupWeight,
		prevent_recursion: entry.preventRecursion,
		delay_until_recursion: entry.delayUntilRecursion,
		scan_depth: entry.scanDepth,
		match_whole_words: entry.matchWholeWords,
		use_group_scoring: entry.useGroupScoring,
		case_sensitive: entry.caseSensitive,
		automation_id: entry.automationId,
		role: entry.role,
		vectorized: entry.vectorized,
		sticky: entry.sticky,
		cooldown: entry.cooldown,
		delay: entry.delay,
		match_persona_description: entry.matchPersonaDescription,
		match_character_description: entry.matchCharacterDescription,
		match_character_personality: entry.matchCharacterPersonality,
		match_character_depth_prompt: entry.matchCharacterDepthPrompt,
		match_scenario: entry.matchScenario,
		match_creator_notes: entry.matchCreatorNotes,
		triggers: entry.triggers,
		ignore_budget: entry.ignoreBudget
	};
	return {
		uid: entry.uid,
		key: entry.key,
		keysecondary: entry.keysecondary,
		comment: entry.comment,
		content: entry.content,
		constant: entry.constant,
		vectorized: entry.vectorized,
		selective: entry.selective,
		selectiveLogic: entry.selectiveLogic,
		addMemo: entry.addMemo,
		order: entry.order,
		position: entry.position,
		disable: entry.disable,
		ignoreBudget: entry.ignoreBudget,
		excludeRecursion: entry.excludeRecursion,
		preventRecursion: entry.preventRecursion,
		matchPersonaDescription: entry.matchPersonaDescription,
		matchCharacterDescription: entry.matchCharacterDescription,
		matchCharacterPersonality: entry.matchCharacterPersonality,
		matchCharacterDepthPrompt: entry.matchCharacterDepthPrompt,
		matchScenario: entry.matchScenario,
		matchCreatorNotes: entry.matchCreatorNotes,
		delayUntilRecursion: entry.delayUntilRecursion,
		probability: entry.probability,
		useProbability: entry.useProbability,
		depth: entry.depth,
		outletName: entry.outletName,
		group: entry.group,
		groupOverride: entry.groupOverride,
		groupWeight: entry.groupWeight,
		scanDepth: entry.scanDepth,
		caseSensitive: entry.caseSensitive,
		matchWholeWords: entry.matchWholeWords,
		useGroupScoring: entry.useGroupScoring,
		automationId: entry.automationId,
		role: entry.role,
		sticky: entry.sticky,
		cooldown: entry.cooldown,
		delay: entry.delay,
		triggers: entry.triggers,
		...entry.keyregex !== void 0 ? { keyregex: entry.keyregex } : {},
		extensions: ext
	};
}
/** Import a SillyTavern preset JSON (any preset_type) into a tavern preset. */
function importPreset(raw, id, name) {
	if (typeof raw !== "object" || raw === null) throw new Error("预设 JSON 无效：不是对象");
	const obj = raw;
	const num = (key) => {
		const value = obj[key];
		return typeof value === "number" && Number.isFinite(value) ? value : void 0;
	};
	return {
		id,
		name,
		createdAt: (/* @__PURE__ */ new Date()).toISOString(),
		updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
		...typeof obj.custom_model === "string" && obj.custom_model !== "" ? { model: obj.custom_model } : {},
		maxTokens: num("max_tokens"),
		temperature: num("temp"),
		topP: num("top_p"),
		topK: num("top_k"),
		topA: num("top_a"),
		typicalP: num("typical_p"),
		minP: num("min_p"),
		repPen: num("rep_pen"),
		repPenRange: num("rep_pen_range"),
		repPenSlope: num("rep_pen_slope"),
		presencePenalty: num("presence_penalty"),
		frequencyPenalty: num("frequency_penalty"),
		raw: { ...obj }
	};
}
/** Serialize a tavern preset back to ST preset JSON. */
function serializePreset(preset) {
	const out = { ...preset.raw ?? {} };
	out.name = preset.name;
	const set = (key, value) => {
		if (value !== void 0) out[key] = value;
	};
	set("max_tokens", preset.maxTokens);
	set("temp", preset.temperature);
	set("top_p", preset.topP);
	set("top_k", preset.topK);
	set("top_a", preset.topA);
	set("typical_p", preset.typicalP);
	set("min_p", preset.minP);
	set("rep_pen", preset.repPen);
	set("rep_pen_range", preset.repPenRange);
	set("rep_pen_slope", preset.repPenSlope);
	set("presence_penalty", preset.presencePenalty);
	set("frequency_penalty", preset.frequencyPenalty);
	if (preset.model !== void 0) out.custom_model = preset.model;
	return out;
}
function str(value) {
	return typeof value === "string" ? value : "";
}
function strArray(value) {
	if (Array.isArray(value)) return value.filter((item) => typeof item === "string");
	if (typeof value === "string") return value.split(",").map((s) => s.trim()).filter((s) => s !== "");
	return [];
}
//#endregion
//#region src/prompt.ts
/**
* Make imported SillyTavern / roleplay text safe for DSH prompt rendering.
* DSH treats every complete `{{name}}` group as a strict prompt-variable
* reference; ST cards often contain literal macros like `{{user}}` / `{{char}}`.
* Since DSH has no escape syntax for literal braces, collapse the double
* braces to single braces (`{user}`) so the card stays readable and the
* prompt renderer never sees an unknown variable.
*/
function stripPromptVariables(text) {
	let out = text;
	while (out.includes("{{") || out.includes("}}")) out = out.split("{{").join("{").split("}}").join("}");
	return out;
}
/** Character card sections joined into the role description. */
function characterProfile(character) {
	const data = character.card.data;
	const sections = [];
	const description = stripPromptVariables(data.description.trim());
	const personality = stripPromptVariables(data.personality.trim());
	const scenario = stripPromptVariables(data.scenario.trim());
	if (description !== "") sections.push(`角色设定：\n${description}`);
	if (personality !== "") sections.push(`性格：\n${personality}`);
	if (scenario !== "") sections.push(`当前场景：\n${scenario}`);
	return sections.join("\n\n");
}
/** System prompt for one character agent (multi-agent mode). */
function buildCharacterSystem(character, loreText, preset, extras) {
	const data = character.card.data;
	const name = stripPromptVariables(data.name);
	const safeLoreText = stripPromptVariables(loreText);
	const safeExtras = extras.map(stripPromptVariables);
	const parts = [];
	parts.push("你正在参与一场角色扮演（roleplay），你是其中的一个角色。");
	parts.push(`你扮演的角色名字是：${name}`);
	const profile = characterProfile(character);
	if (profile !== "") parts.push(profile);
	if (safeLoreText !== "") parts.push(safeLoreText);
	if (safeExtras.length > 0) parts.push(safeExtras.join("\n"));
	const presetSystem = stripPromptVariables(preset?.systemPrompt ?? "").trim();
	const cardSystem = stripPromptVariables(data.system_prompt).trim();
	if (presetSystem !== "") parts.push(presetSystem);
	else if (cardSystem !== "") parts.push(cardSystem);
	parts.push([
		"扮演规则：",
		`- 你只扮演 ${name}，只输出 ${name} 的台词、动作与内心活动；不要替其他角色发言。`,
		"- 台词直接输出，动作与神态描写用 *斜体* 或括号括起。",
		"- 不要输出关于你自己的解释、不要提及\"角色扮演\"或\"AI\"等字眼，除非角色设定要求。",
		"- 保持角色的一致性，回应要自然、有代入感。"
	].join("\n"));
	const postHistory = stripPromptVariables(data.post_history_instructions).trim();
	if (postHistory !== "") parts.push(`扮演补充规则：\n${postHistory}`);
	return parts.join("\n\n");
}
/** Classic single-agent system prompt (narrator plays everyone). */
function buildClassicSystem(play, characters, loreText, preset) {
	const parts = [];
	parts.push("你正在主持并参与一场角色扮演。你同时扮演以下所有角色与叙述者：");
	for (const id of play.characterIds) {
		const character = characters.find((c) => c.id === id);
		if (character === void 0) continue;
		const data = character.card.data;
		parts.push(`【角色 ${stripPromptVariables(data.name)}】`);
		const profile = characterProfile(character);
		if (profile !== "") parts.push(profile);
		const cardSystem = stripPromptVariables(data.system_prompt).trim();
		if (cardSystem !== "") parts.push(cardSystem);
	}
	const safeLoreText = stripPromptVariables(loreText);
	if (safeLoreText !== "") parts.push(safeLoreText);
	const presetSystem = stripPromptVariables(preset?.systemPrompt ?? "").trim();
	if (presetSystem !== "") parts.push(presetSystem);
	parts.push([
		"扮演规则：",
		"- 每个角色发言时以「角色名：」开头，叙述与场景描写直接输出。",
		"- 台词直接输出，动作与神态描写用 *斜体* 或括号括起。",
		"- 保持各角色设定一致，回应自然、有代入感，避免冗长。"
	].join("\n"));
	return parts.join("\n\n");
}
//#endregion
//#region src/lorebook.ts
const DEFAULT_ROLL = () => Math.random();
/** Match one key against the scan text. */
function keyMatches(key, scan, entry) {
	if (entry.keyregex) try {
		const flags = entry.caseSensitive ? "" : "i";
		return new RegExp(entry.keyregex, flags).test(scan.text);
	} catch {}
	const caseSensitive = entry.caseSensitive ?? false;
	const needle = caseSensitive ? key : key.toLowerCase();
	const haystack = caseSensitive ? scan.text : scan.text.toLowerCase();
	if (!(entry.matchWholeWords ?? false)) return haystack.includes(needle);
	const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}(?=[^\\p{L}\\p{N}_]|$)`, "u").test(haystack);
}
/**
* Run one book against the scan and return activated entries ordered for
* insertion (by position ascending, constant entries first).
*/
function activateBook(book, scan) {
	const roll = scan.roll ?? DEFAULT_ROLL;
	const activated = [];
	const groupPick = /* @__PURE__ */ new Map();
	for (const entry of book.entries) {
		if (entry.disable) continue;
		if (entry.constant) {
			activated.push({
				entry,
				matchedKeys: []
			});
			continue;
		}
		if (typeof entry.depth === "number" && entry.depth > 0 && scan.depth < entry.depth) continue;
		const prob = entry.useProbability ? entry.probability : void 0;
		if (typeof prob === "number" && prob < 100 && roll() * 100 > prob) continue;
		const keys = [...entry.key ?? []];
		if (entry.keysecondary && entry.keysecondary.length > 0) keys.push(...entry.keysecondary);
		const matched = keys.filter((key) => key !== "" && keyMatches(key, scan, entry));
		if (matched.length === 0) continue;
		if (entry.group !== "") {
			const current = groupPick.get(entry.group);
			const weight = entry.groupWeight ?? 0;
			if (current === void 0 || (current.groupWeight ?? 0) < weight) groupPick.set(entry.group, entry);
			continue;
		}
		activated.push({
			entry,
			matchedKeys: matched
		});
	}
	for (const entry of groupPick.values()) activated.push({
		entry,
		matchedKeys: []
	});
	activated.sort((a, b) => {
		return (a.entry.extensions?.position ?? a.entry.position ?? 0) - (b.entry.extensions?.position ?? b.entry.position ?? 0);
	});
	return activated;
}
/** Render active entries into one world-info text block. */
function renderWorldInfo(activated) {
	if (activated.length === 0) return "";
	return ["[世界书 / World Info]", ...activated.map(({ entry }) => stripPromptVariables(entry.content.trim())).map((line) => `- ${line}`)].join("\n");
}
//#endregion
//#region src/tavern-preset.ts
/**
* The tavern agent preset: a minimal-like composition the tavern session
* runtime mounts for every play session (director and character agents).
*
* Why a custom preset instead of the shipped `minimal` one: minimal disables
* dynamic runtime-context snapshots (`includeRuntimeContext: false`), which
* would also suppress the world-book context the tavern injects. This preset
* mirrors minimal's lean tool composition (persistent bash + editor) but
* keeps runtime-context injection on.
*
* The preset's persona row is a fallback only: the tavern setup registers the
* play's own system prompt into the same `deployment:persona` slot on the
* agent scope, which shadows the preset persona (nearest scope wins), so the
* model always sees the character-card composition instead of this text.
*
* The preset is authored into the harness-home user root (`.agent-presets`),
* the same place a person or an agent would author a preset by hand. Writing
* is non-clobbering: an existing `tavern` preset — the user's own edits
* included — is left untouched and mounted as it stands.
*/
/** Preset id (directory name) under the user preset root. */
const TAVERN_PRESET_ID = "tavern";
/** Composition file, mirroring the shipped `minimal` preset. */
const TAVERN_PRESET_COMPOSITION = `# The tavern agent preset: minimal-like, runtime-context injection enabled.
#
# Managed by dsh-tavern (written once when missing). Edit freely: the plugin
# mounts this preset as it stands and never overwrites user edits.
#
# Differs from the shipped \`minimal\` preset in exactly one setting:
# \`includeRuntimeContext: true\` keeps dynamic context injection (the world
# book) flowing into tavern sessions.
#
# The persona row below is a fallback: the tavern setup registers the play's
# own system prompt (character cards etc.) into the \`deployment:persona\` slot
# on the agent scope, which shadows this row's section.
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: You are a helpful assistant.
    complete: true
    includeRuntimeContext: true

# The PTY registry is an agent-owned service, so it lives in an entry-local
# realm. The backend still consumes the host sandbox policy and subprocess
# implementation, while the tool registers into this agent's scoped catalog.
- id: persistent-shell
  name: cordis:group
  group: true
  isolate:
    terminals: true
  config:
    - id: pty
      name: '@deepseek-ai/dsh-terminal'

    - id: terminal-bash
      name: '@deepseek-ai/dsh-terminal-bash'
      config:
        timeoutMs: 300000

    - id: persistent-bash
      name: '@deepseek-ai/dsh-tool-bash-persistent'
      config:
        timeoutMs: 300000
        description: |-
          Run commands in a bash shell
          * When invoking this tool, the contents of the "command" parameter does NOT need to be XML-escaped.
          * You don't have access to the internet via this tool.
          * You do have access to a mirror of common linux and python packages via apt and pip.
          * State is persistent across command calls and discussions with the user.
          * To inspect a particular line range of a file, e.g. lines 10-25, try 'sed -n 10,25p /path/to/the/file'.
          * Please avoid commands that may produce a very large amount of output.
          * Please run long lived commands in the background, e.g. 'sleep 10 &' or start a server in the background.

# The bare local filesystem shadows the host's sandboxed provider only for this
# preset. The editor shares that realm and requires absolute paths.
- id: filesystem
  name: cordis:group
  group: true
  isolate:
    fs: true
  config:
    - id: fs-local
      name: '@deepseek-ai/dsh-fs-local'
      config:
        cwd: !!js process.env.DSH_CWD ?? process.cwd()

    - id: str-replace-editor
      name: '@deepseek-ai/dsh-tool-str-replace-editor'
      config:
        maxOutputChars: 16000
`;
/** Display metadata beside the composition. */
const TAVERN_PRESET_METADATA = `name: 酒馆极简模式
description: 酒馆角色扮演专用极简预设（持久 bash + 编辑器），开启动态上下文注入。
order: 4
`;
/** The preset directory under the harness home. */
function presetDirectory(home) {
	return home(".agent-presets", TAVERN_PRESET_ID);
}
/**
* Write one preset file when it does not already exist.
* @param path - target file.
* @param content - the file content to write.
*/
async function writeIfMissing(path, content) {
	let handle;
	try {
		handle = await open(path, "wx");
	} catch (error) {
		if (error.code === "EEXIST") return;
		throw error;
	}
	try {
		await handle.writeFile(content, "utf8");
	} finally {
		await handle.close();
	}
}
/**
* Author the tavern preset into the harness-home user root. Idempotent and
* non-clobbering: existing files are never rewritten.
* @param home - the harness home path resolver (ctx.dshHomePath).
*/
async function ensureTavernPreset(home) {
	const dir = presetDirectory(home);
	await mkdir(dir, { recursive: true });
	await writeIfMissing(join(dir, "agent.cordis.yml"), TAVERN_PRESET_COMPOSITION);
	await writeIfMissing(join(dir, "preset.yml"), TAVERN_PRESET_METADATA);
}
//#endregion
//#region src/play.ts
/**
* The system-prompt persona slot the tavern director/character prompts take
* over. Mirrors `PERSONA_SECTION`/`PERSONA_ORDER` from dsh-system-prompt
* (hardcoded to keep the host half free of @deepseek-ai runtime imports):
* registering under this name shadows the preset persona in the agent scope,
* so the tavern prompt and the preset's fixed persona never fight over the
* complete-section slot.
*/
const PERSONA_SECTION = "deployment:persona";
const PERSONA_ORDER = 0;
/** Resolve the effective world-book ids for a play (new array field + legacy scalar field). */
function playLorebookIds(play) {
	const ids = Array.isArray(play.lorebookIds) ? play.lorebookIds.filter((id) => typeof id === "string" && id !== "") : [];
	if (typeof play.lorebookId === "string" && play.lorebookId !== "" && !ids.includes(play.lorebookId)) ids.unshift(play.lorebookId);
	return [...new Set(ids)];
}
/** Build a user message carrying tavern plugin provenance. */
function userMessage(content) {
	return {
		id: crypto.randomUUID(),
		role: "user",
		content: [{
			type: "text",
			text: content
		}],
		source: {
			kind: "plugin",
			plugin: "dsh-tavern"
		}
	};
}
/** Extract the final assistant text from an agent's session log. */
function lastAssistantText(session) {
	const events = session.events;
	for (let index = events.length - 1; index >= 0; index--) {
		const event = events[index];
		if (event === void 0) continue;
		if (event.type !== "assistant/message") continue;
		const text = event.data.message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
		if (text.trim() !== "") return text;
	}
	return "";
}
/** Resolve the effective model selection for one generation. */
function resolveModel(deps, preset) {
	if (preset?.provider && preset.model) return {
		provider: preset.provider,
		model: preset.model,
		maxTokens: preset.maxTokens
	};
	const fallback = deps.defaultModel();
	return {
		provider: preset?.provider ?? fallback.provider,
		model: preset?.model ?? fallback.model,
		reasoningEffort: fallback.reasoningEffort,
		maxTokens: preset?.maxTokens
	};
}
/** Build a balanced completed-turn seed carrying the greeting. */
function greetingSeed(greeting, provider, model) {
	const safeGreeting = stripPromptVariables(greeting);
	const time = Date.now();
	const assistant = {
		type: "assistant/message",
		seq: 2,
		time,
		data: {
			turn: 1,
			step: 1,
			message: {
				id: crypto.randomUUID(),
				role: "assistant",
				content: [{
					type: "text",
					text: safeGreeting
				}],
				source: {
					kind: "model",
					provider,
					model
				}
			}
		},
		surfaceOp: "append"
	};
	return [
		{
			type: "turn/start",
			seq: 0,
			time,
			data: { turn: 1 }
		},
		{
			type: "user/message",
			seq: 1,
			time,
			data: userMessage("[开场] 扮演开始。"),
			surfaceOp: "append"
		},
		assistant,
		{
			type: "turn/end",
			seq: 3,
			time,
			data: {
				turn: 1,
				reason: { kind: "completed" }
			}
		}
	];
}
/**
* The tavern session runtime: owns the director and character agents of
* every play, keyed by play id, and exposes the `tavern_speak` execution.
*/
var TavernSessionRuntime = class {
	deps;
	/** playId → director handle. */
	directors = /* @__PURE__ */ new Map();
	/** playId → (characterId → handle). */
	roles = /* @__PURE__ */ new Map();
	/** agentId → tail promise serializing tavern_speak calls per character agent. */
	speakQueues = /* @__PURE__ */ new Map();
	constructor(deps) {
		this.deps = deps;
	}
	/** Dispose every live agent (called from the plugin's teardown effect). */
	dispose() {
		for (const handle of this.directors.values()) handle.dispose().catch(() => {});
		this.directors.clear();
		for (const byPlay of this.roles.values()) for (const handle of byPlay.values()) handle.dispose().catch(() => {});
		this.roles.clear();
		this.speakQueues.clear();
	}
	/** Run one tavern_speak task after any previous task for the same agent settles. */
	enqueueSpeak(key, task) {
		const run = (this.speakQueues.get(key) ?? Promise.resolve()).catch(() => {}).then(task);
		this.speakQueues.set(key, run.then(() => void 0, () => void 0));
		return run;
	}
	/** Live director agent for a play, or undefined. */
	getDirector(playId) {
		return this.directors.get(playId)?.agent;
	}
	/**
	* Assemble (create or resume) the director agent for a play. Idempotent per
	* process: the director's session id is the play-bound DSH session. When
	* the persisted session exists (a previous run), it is resumed so history
	* survives restarts; otherwise a fresh session is created. Every play
	* session runs under the tavern agent preset and is archived so the
	* workspace browser (「对话」页) never lists it — the play lives inside the
	* tavern page only.
	*/
	async ensureDirector(play) {
		const existing = this.directors.get(play.id);
		if (existing !== void 0) return existing;
		const storage = this.deps.storage;
		const characters = play.characterIds.map((id) => storage.getCharacter(id)).filter((c) => c !== void 0);
		const lorebooks = this.playLorebooks(play);
		const preset = play.presetId !== void 0 ? storage.getPreset(play.presetId) : void 0;
		const model = resolveModel(this.deps, preset);
		const sessionId = play.sessionId;
		const directorSystem = this.buildDirectorSystem(play, characters, preset);
		const loreContext = this.buildLoreContext(lorebooks, characters);
		await this.deps.ensurePreset();
		const persistedPreset = await this.persistedPreset(sessionId);
		const setup = this.sessionSetup(persistedPreset ?? "tavern", directorSystem, loreContext);
		const agentOptions = {
			...model.provider === void 0 ? {} : { provider: model.provider },
			...model.model === void 0 ? {} : { model: model.model },
			...model.maxTokens === void 0 ? {} : { maxTokens: model.maxTokens }
		};
		let handle;
		if (persistedPreset !== void 0) try {
			handle = await this.deps.agents.resume({
				resumeSessionId: sessionId,
				agentOptions,
				setup
			});
		} catch (error) {
			this.deps.logger.warn(`tavern: resume director failed (${String(error)}); creating fresh session`);
			handle = await this.deps.agents.create({
				sessionId,
				agentOptions,
				meta: { agentPreset: persistedPreset },
				setup,
				...play.greeting !== void 0 && play.greeting !== "" ? { seed: greetingSeed(play.greeting, model.provider ?? "default", model.model ?? "default") } : {}
			});
		}
		else handle = await this.deps.agents.create({
			sessionId,
			agentOptions,
			meta: { agentPreset: TAVERN_PRESET_ID },
			setup,
			...play.greeting !== void 0 && play.greeting !== "" ? { seed: greetingSeed(play.greeting, model.provider ?? "default", model.model ?? "default") } : {}
		});
		this.directors.set(play.id, handle);
		await this.hideFromWorkspace(sessionId);
		return handle;
	}
	/**
	* The preset a persisted session actually runs, newest selection winning
	* (mirrors `resolveSessionPreset` from dsh-agent-presets; inlined to keep
	* the host half free of @deepseek-ai runtime imports).
	* @param header - the persisted session's creation header.
	* @param events - the persisted session's event log, oldest first.
	* @returns the recorded preset id, or undefined for a session composed bare.
	*/
	recordedPreset(header, events) {
		for (let index = events.length - 1; index >= 0; index -= 1) {
			const event = events[index];
			if (event?.type === "agent-preset/selected") return event.data.agentPreset;
		}
		return header.agentPreset;
	}
	/**
	* Probe the persisted session for the preset it was produced under.
	* @param sessionId - the session to probe.
	* @returns the recorded preset id, or undefined when the session is not
	* persisted (a fresh play) or has none recorded (legacy).
	*/
	async persistedPreset(sessionId) {
		try {
			const inspected = await this.deps.sessionPersistence.inspect(sessionId);
			return this.recordedPreset(inspected.meta, inspected.events);
		} catch {
			return;
		}
	}
	/**
	* Compose one play session's scoped world: mount the session's agent
	* preset (when it has one), then register the play's own system prompt
	* into the persona slot and the world-book dynamic context.
	* @param presetId - preset to mount, or undefined to compose bare (legacy).
	* @param system - the director/character system prompt text.
	* @param loreContext - the world-book dynamic context, or null.
	*/
	sessionSetup(presetId, system, loreContext) {
		return async (agentCtx) => {
			if (presetId !== void 0) try {
				await this.deps.agentPresets.mount(agentCtx, presetId);
			} catch (error) {
				this.deps.logger.warn(`tavern: preset "${presetId}" failed to mount (${String(error)}); session runs without it`);
			}
			agentCtx.systemPrompt.section({
				name: PERSONA_SECTION,
				order: PERSONA_ORDER,
				complete: true,
				text: system
			});
			if (loreContext !== null) agentCtx.systemPrompt.context(loreContext);
		};
	}
	/**
	* Archive one play session: tavern sessions are hidden from every workspace
	* grouping surface (the 对话 page) and live inside the tavern page only.
	* Idempotent; failures only log because a play must stay usable.
	* @param sessionId - the session to hide.
	*/
	async hideFromWorkspace(sessionId) {
		try {
			await this.deps.workspace.archiveSession(sessionId);
		} catch (error) {
			this.deps.logger.warn(`tavern: failed to archive session "${sessionId}": ${String(error)}`);
		}
	}
	/** Compose the director's system prompt. */
	buildDirectorSystem(play, characters, preset) {
		if (play.multiAgent) {
			const parts = [];
			parts.push("你是一场角色扮演（roleplay）的主持者（director）。");
			const names = play.characterIds.map((id) => characters.find((c) => c.id === id)?.card.data.name).filter((name) => name !== void 0).map((name) => stripPromptVariables(name));
			if (names.length > 0) parts.push(`在场角色：${names.join("、")}`);
			for (const character of characters) {
				const data = character.card.data;
				parts.push(`【角色 ${stripPromptVariables(data.name)}】\n${characterProfile(character)}`);
			}
			const presetSystem = stripPromptVariables(preset?.systemPrompt ?? "").trim();
			if (presetSystem !== "") parts.push(presetSystem);
			parts.push([
				"主持规则：",
				`- 当剧情需要角色发言时，调用 tavern_speak 工具（参数 characterName=角色名、instruction=你想让角色表达的内容），工具会返回该角色的台词，你直接把它写进回复。`,
				`- 你可以描写场景、环境、NPC 与旁白（${play.narratorEnabled ? "叙述者功能已启用，请经常描写场景" : "叙述保持克制，以对话为主"}）。`,
				"- 台词直接输出，动作与神态描写用 *斜体* 或括号括起。",
				"- 保持各角色设定一致，不要替角色编造与其性格冲突的发言。"
			].join("\n"));
			return parts.join("\n\n");
		}
		return buildClassicSystem(play, characters, renderWorldInfo([]), preset);
	}
	/** Dynamic world-book context for the director's assembly. */
	buildLoreContext(lorebooks, characters) {
		if (lorebooks.length === 0) return null;
		return {
			name: "tavern:world",
			order: 50,
			text: (context) => {
				const agent = context.agent;
				if (agent === void 0) return "";
				const scanText = this.recentSessionText(agent.session, characters);
				const depth = agent.session.events.filter((e) => e.type === "user/message").length;
				return renderWorldInfo(lorebooks.flatMap((book) => activateBook(book.book, {
					text: scanText,
					depth
				})));
			}
		};
	}
	/** Resolve the world-book records bound to one play, in play order. */
	playLorebooks(play) {
		return playLorebookIds(play).map((id) => this.deps.storage.getLorebook(id)).filter((book) => book !== void 0);
	}
	/** Recent user/assistant text of a session, newest last (world-book scan). */
	recentSessionText(session, characters) {
		const lines = [];
		for (const event of session.events) if (event.type === "user/message") {
			const text = event.data.content.filter((block) => block.type === "text").map((block) => block.text).join("");
			lines.push(text);
		} else if (event.type === "assistant/message") {
			const text = event.data.message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
			if (text.trim() !== "") lines.push(text);
		}
		return lines.slice(-12).join("\n");
	}
	/**
	* Execute one tavern_speak call: route to the named character agent (in
	* multi-agent mode), or fall back to the director's own voice.
	* @param exec - tool execution context (its agent is the director).
	* @param args - characterName/characterId plus the instruction.
	* @returns the character's lines.
	*/
	async speakFor(exec, args) {
		const director = exec.agent;
		if (director === void 0) throw new Error("tavern_speak: 只能在扮演会话中调用");
		const play = this.deps.storage.listPlays().find((p) => p.sessionId === director.id);
		if (play === void 0) throw new Error("tavern_speak: 找不到该会话对应的酒馆配置");
		const characters = play.characterIds.map((id) => this.deps.storage.getCharacter(id)).filter((c) => c !== void 0);
		const target = characters.find((c) => args.characterId !== void 0 && c.id === args.characterId || args.characterName !== void 0 && c.card.data.name === args.characterName) ?? characters[0];
		if (target === void 0) throw new Error("tavern_speak: 角色列表为空");
		const instruction = args.instruction ?? `请以${target.card.data.name}的身份说下一句台词。`;
		const handle = await this.ensureRoleAgent(play, target);
		return this.enqueueSpeak(String(handle.agent.id), async () => {
			const signal = exec.signal;
			const done = handle.agent.whenIdle();
			handle.agent.followup(userMessage(instruction));
			const wait = done.catch(() => {});
			let onAbort;
			const timeout = new Promise((_, reject) => {
				const timer = setTimeout(() => reject(/* @__PURE__ */ new Error("角色回应超时")), 12e4);
				onAbort = () => {
					clearTimeout(timer);
					reject(/* @__PURE__ */ new Error("调用已取消"));
				};
				if (signal.aborted) {
					onAbort();
					return;
				}
				signal.addEventListener("abort", onAbort, { once: true });
				wait.then(() => {
					clearTimeout(timer);
					signal.removeEventListener("abort", onAbort);
				});
			});
			await Promise.race([wait, timeout]);
			const reply = lastAssistantText(handle.agent.session);
			if (reply.trim() === "") throw new Error(`${target.card.data.name} 没有产出回复`);
			return { reply: reply.trim() };
		});
	}
	/** Create (or reuse) the character agent for one play (multi-agent mode). */
	async ensureRoleAgent(play, character) {
		let byPlay = this.roles.get(play.id);
		if (byPlay === void 0) {
			byPlay = /* @__PURE__ */ new Map();
			this.roles.set(play.id, byPlay);
		}
		const existing = byPlay.get(character.id);
		if (existing !== void 0) return existing;
		const lorebooks = this.playLorebooks(play);
		const preset = play.presetId !== void 0 ? this.deps.storage.getPreset(play.presetId) : void 0;
		const model = resolveModel(this.deps, preset);
		const characters = play.characterIds.map((id) => this.deps.storage.getCharacter(id)).filter((c) => c !== void 0);
		const names = characters.map((c) => c.card.data.name).filter((n) => n !== character.card.data.name);
		const system = buildCharacterSystem(character, "", preset, names.length > 0 ? [`同场角色：${names.join("、")}`] : []);
		const sessionId = `tavern-role-${play.id.slice(0, 8)}-${character.id.slice(0, 8)}`;
		const loreContext = this.buildLoreContext(lorebooks, characters);
		await this.deps.ensurePreset();
		const persistedPreset = await this.persistedPreset(sessionId);
		const setup = this.sessionSetup(persistedPreset ?? "tavern", system, loreContext);
		const agentOptions = {
			...model.provider === void 0 ? {} : { provider: model.provider },
			...model.model === void 0 ? {} : { model: model.model },
			...model.maxTokens === void 0 ? {} : { maxTokens: model.maxTokens }
		};
		let handle;
		if (persistedPreset !== void 0) try {
			handle = await this.deps.agents.resume({
				resumeSessionId: sessionId,
				agentOptions,
				setup
			});
		} catch (error) {
			this.deps.logger.warn(`tavern: resume character failed (${String(error)}); creating fresh session`);
			handle = await this.deps.agents.create({
				sessionId,
				agentOptions,
				meta: { agentPreset: persistedPreset },
				setup
			});
		}
		else handle = await this.deps.agents.create({
			sessionId,
			agentOptions,
			meta: { agentPreset: TAVERN_PRESET_ID },
			setup
		});
		byPlay.set(character.id, handle);
		await this.hideFromWorkspace(sessionId);
		return handle;
	}
	/** Drop the live agents of one play (play deleted). */
	async dropPlay(playId) {
		const director = this.directors.get(playId);
		if (director !== void 0) {
			this.directors.delete(playId);
			this.speakQueues.delete(String(director.agent.id));
			await director.dispose();
		}
		const byPlay = this.roles.get(playId);
		if (byPlay !== void 0) {
			this.roles.delete(playId);
			for (const handle of byPlay.values()) {
				this.speakQueues.delete(String(handle.agent.id));
				await handle.dispose();
			}
		}
	}
};
//#endregion
//#region src/tauritavern.ts
/**
* Local TauriTavern data-directory importer.
*
* TauriTavern stores its user data in the SillyTavern layout:
*
* - portable install:  <app>/data/default-user
* - standard install:  <app-data>/data/default-user
* - selected data root: <configured data_root>/default-user
*
* The importer accepts any of the app root, data root, or default-user path
* (or a child directory such as .../default-user/characters), detects the
* default-user directory, and batch-imports the tavern-managed categories:
* character PNG cards, standalone world books, and AI presets.
*/
const DEFAULT_USER_DIR = "default-user";
/** Preset directories used by TauriTavern / SillyTavern. */
const TAURITAVERN_PRESET_DIRS = [
	"KoboldAI Settings",
	"NovelAI Settings",
	"OpenAI Settings",
	"TextGen Settings",
	"instruct",
	"context",
	"sysprompt",
	"reasoning"
];
/** Directories that prove a directory is a TauriTavern user directory. */
const USER_DIR_MARKERS = [
	"characters",
	"worlds",
	...TAURITAVERN_PRESET_DIRS
];
async function isDirectory(filePath) {
	try {
		return (await promises.stat(filePath)).isDirectory();
	} catch {
		return false;
	}
}
async function isFile(filePath) {
	try {
		return (await promises.stat(filePath)).isFile();
	} catch {
		return false;
	}
}
/** Read `data_root` from a `tauritavern-runtime.json` file, if present. */
async function runtimeConfiguredUserDir(appRoot) {
	const configPath = path.join(appRoot, "tauritavern-runtime.json");
	if (!await isFile(configPath)) return void 0;
	try {
		const config = JSON.parse(await promises.readFile(configPath, "utf8"));
		if (typeof config.data_root !== "string" || config.data_root.trim() === "") return void 0;
		const dataRoot = path.isAbsolute(config.data_root) ? path.normalize(config.data_root) : path.resolve(appRoot, config.data_root);
		return path.join(dataRoot, DEFAULT_USER_DIR);
	} catch {
		return;
	}
}
/**
* Walk from the supplied path upward and find the TauriTavern
* `default-user` directory. Supports:
*
* - `<app>/data/default-user` (portable / standard app data)
* - `<app>/default-user` (when the app root is itself the data root)
* - `<data-root>/default-user` (custom data root selected in TauriTavern)
* - any child path of the above.
*/
async function resolveTauriTavernDirectory(input) {
	const trimmed = input.trim();
	const raw = trimmed.length >= 2 && (trimmed[0] === "\"" && trimmed.at(-1) === "\"" || trimmed[0] === "'" && trimmed.at(-1) === "'") ? trimmed.slice(1, -1).trim() : trimmed;
	if (raw === "") throw new Error("请输入 TauriTavern 安装目录或数据目录");
	if (!path.isAbsolute(raw)) throw new Error("TauriTavern 目录必须是绝对路径，例如 E:\\TauriTavern");
	let current = path.normalize(raw);
	while (true) {
		if (await isDirectory(current)) {
			const configured = await runtimeConfiguredUserDir(current);
			if (configured !== void 0 && await isDirectory(configured)) return {
				input: raw,
				root: path.dirname(configured),
				userDir: configured
			};
			const base = path.basename(current).toLowerCase();
			const candidates = [];
			if (base === DEFAULT_USER_DIR) candidates.push({
				root: path.dirname(current),
				userDir: current
			});
			candidates.push({
				root: path.join(current, "data"),
				userDir: path.join(current, "data", DEFAULT_USER_DIR)
			});
			candidates.push({
				root: current,
				userDir: path.join(current, DEFAULT_USER_DIR)
			});
			for (const candidate of candidates) if (await isDirectory(candidate.userDir)) return {
				input: raw,
				root: candidate.root,
				userDir: candidate.userDir
			};
		}
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	if (process.platform === "win32" && /tauritavern/i.test(path.basename(raw))) {
		const appData = process.env.APPDATA;
		if (appData !== void 0 && appData !== "") for (const name of [
			"com.tauritavern.client",
			"TauriTavern",
			"tauritavern"
		]) {
			const base = path.join(appData, name);
			const configured = await runtimeConfiguredUserDir(base);
			if (configured !== void 0 && await isDirectory(configured)) return {
				input: raw,
				root: path.dirname(configured),
				userDir: configured
			};
			for (const userDir of [path.join(base, "data", DEFAULT_USER_DIR), path.join(base, DEFAULT_USER_DIR)]) if (await isDirectory(userDir)) return {
				input: raw,
				root: path.dirname(userDir),
				userDir
			};
		}
	}
	throw new Error(`未找到 TauriTavern 数据目录（${raw}）。请填写安装目录、data 目录或 default-user 目录`);
}
async function hasSupportedUserData(userDir) {
	for (const marker of USER_DIR_MARKERS) if (await isDirectory(path.join(userDir, marker))) return true;
	return false;
}
async function listFiles(dir) {
	try {
		return (await promises.readdir(dir, { withFileTypes: true })).filter((entry) => entry.isFile() || entry.isSymbolicLink()).map((entry) => entry.name).sort((a, b) => a.localeCompare(b, "zh-CN"));
	} catch (error) {
		if (error.code === "ENOENT") return [];
		throw error;
	}
}
function stripBom(text) {
	return text.charCodeAt(0) === 65279 ? text.slice(1) : text;
}
function relativeTo(userDir, filePath) {
	const relative = path.relative(userDir, filePath);
	return relative === "" ? path.basename(filePath) : relative;
}
function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}
/** Normalize an import source path for case-insensitive comparison. */
function normalizeSource(source) {
	return source.replace(/\\/g, "/").toLowerCase();
}
/** Keep only incoming records whose source path is not already imported. */
function dedupeBySource(existing, incoming) {
	const seen = new Set(existing.map((record) => record.source).filter((source) => source !== void 0).map(normalizeSource));
	return incoming.filter((record) => record.source === void 0 || !seen.has(normalizeSource(record.source)));
}
/** Idempotence for world books imported before the source field existed. */
function dedupeLorebooks(existing, incoming) {
	const seen = new Set(existing.map((record) => record.source !== void 0 ? normalizeSource(record.source) : void 0).filter((source) => source !== void 0));
	const signatures = new Set(existing.map((record) => `${record.name}\u0000${JSON.stringify(record.book)}`));
	return incoming.filter((record) => {
		if (record.source !== void 0 && seen.has(normalizeSource(record.source))) return false;
		return !signatures.has(`${record.name}\u0000${JSON.stringify(record.book)}`);
	});
}
/** Idempotence for presets imported before the source field existed. */
function dedupePresets(existing, incoming) {
	const seen = new Set(existing.map((record) => record.source !== void 0 ? normalizeSource(record.source) : void 0).filter((source) => source !== void 0));
	const signatures = new Set(existing.map((record) => `${record.name}\u0000${JSON.stringify(record.raw ?? {})}`));
	return incoming.filter((record) => {
		if (record.source !== void 0 && seen.has(normalizeSource(record.source))) return false;
		return !signatures.has(`${record.name}\u0000${JSON.stringify(record.raw ?? {})}`);
	});
}
/**
* Parse the journal key used by TauriTavern's content-addressed character
* records (`data/default-user/characters/<name>.png-<timestamp>`).
*/
function characterJournalStem(key) {
	const normalized = key.replace(/\\/g, "/");
	const rel = normalized.startsWith("data/default-user/characters/") ? normalized.slice(29) : normalized;
	const match = /^(.+)\.png-(\d+(?:\.\d+)?)$/.exec(rel);
	if (match === null || match[1] === void 0 || match[2] === void 0) return void 0;
	const stem = match[1];
	if (stem.includes("/") || stem.includes("\\")) return void 0;
	const timestamp = Number(match[2]);
	if (!Number.isFinite(timestamp)) return void 0;
	return {
		stem,
		timestamp
	};
}
/** Read one normal PNG/JSON character card. */
async function readCharacterFile(userDir, charactersDir, file) {
	const filePath = path.join(charactersDir, file);
	const source = relativeTo(userDir, filePath);
	const bytes = await promises.readFile(filePath);
	let card;
	let avatar;
	if (file.toLowerCase().endsWith(".png")) {
		const parsed = parsePngCard(bytes);
		if (parsed === null) throw new Error("PNG 中未找到人物卡数据（chara/ccv3 tEXt 块）");
		card = normalizeCard(JSON.parse(parsed.json), source);
		if (parsed.avatar !== void 0) avatar = `data:image/png;base64,${parsed.avatar.toString("base64")}`;
	} else {
		const text = stripBom(bytes.toString("utf8"));
		card = normalizeCard(JSON.parse(text), source);
	}
	return {
		id: newId("char"),
		source,
		...avatar !== void 0 ? { avatar } : {},
		createdAt: nowIso(),
		updatedAt: nowIso(),
		card
	};
}
/**
* Fallback for TauriTavern data directories that only contain
* content-addressed `{ key, value }` character journal files and no current
* PNG cards: import the newest journal record per character file stem.
*/
async function importCharacterJournalRecords(userDir, charactersDir, files, issues) {
	const latest = /* @__PURE__ */ new Map();
	for (const file of files) {
		const filePath = path.join(charactersDir, file);
		const source = relativeTo(userDir, filePath);
		try {
			const parsed = JSON.parse(stripBom(await promises.readFile(filePath, "utf8")));
			if (typeof parsed !== "object" || parsed === null) continue;
			const record = parsed;
			if (typeof record.key !== "string") continue;
			const stemInfo = characterJournalStem(record.key);
			if (stemInfo === void 0) continue;
			const current = latest.get(stemInfo.stem.toLowerCase());
			if (current === void 0 || stemInfo.timestamp > current.timestamp) latest.set(stemInfo.stem.toLowerCase(), {
				timestamp: stemInfo.timestamp,
				file
			});
		} catch (error) {
			issues.push({
				category: "character",
				file: source,
				reason: errorMessage(error)
			});
		}
	}
	const records = [];
	for (const [stem, entry] of [...latest.entries()].sort(([a], [b]) => a.localeCompare(b, "zh-CN"))) {
		const filePath = path.join(charactersDir, entry.file);
		const source = relativeTo(userDir, path.join(charactersDir, `${stem}.png`));
		try {
			const parsed = JSON.parse(stripBom(await promises.readFile(filePath, "utf8")));
			const rawCard = typeof parsed.value === "string" ? JSON.parse(parsed.value) : parsed.value;
			records.push({
				id: newId("char"),
				source,
				createdAt: nowIso(),
				updatedAt: nowIso(),
				card: normalizeCard(rawCard, source)
			});
		} catch (error) {
			issues.push({
				category: "character",
				file: source,
				reason: errorMessage(error)
			});
		}
	}
	return records;
}
async function importCharacters(userDir, charactersDir, issues) {
	const allFiles = await listFiles(charactersDir);
	const normalFiles = allFiles.filter((name) => /\.(png|json)$/i.test(name));
	const records = [];
	for (const file of normalFiles) try {
		records.push(await readCharacterFile(userDir, charactersDir, file));
	} catch (error) {
		issues.push({
			category: "character",
			file: relativeTo(userDir, path.join(charactersDir, file)),
			reason: errorMessage(error)
		});
	}
	if (normalFiles.length === 0) {
		const journalFiles = allFiles.filter((name) => !/\.(png|json)$/i.test(name));
		records.push(...await importCharacterJournalRecords(userDir, charactersDir, journalFiles, issues));
	}
	return records;
}
async function importLorebooks(userDir, worldsDir, issues) {
	const records = [];
	const files = (await listFiles(worldsDir)).filter((name) => name.toLowerCase().endsWith(".json"));
	for (const file of files) {
		const filePath = path.join(worldsDir, file);
		const source = relativeTo(userDir, filePath);
		try {
			const raw = JSON.parse(stripBom(await promises.readFile(filePath, "utf8")));
			const book = normalizeWorldBook(raw);
			const rawName = raw?.name;
			const name = typeof rawName === "string" && rawName.trim() !== "" ? rawName : path.basename(file, ".json");
			records.push({
				id: newId("book"),
				name,
				source,
				createdAt: nowIso(),
				updatedAt: nowIso(),
				book
			});
		} catch (error) {
			issues.push({
				category: "lorebook",
				file: source,
				reason: errorMessage(error)
			});
		}
	}
	return records;
}
async function importPresets(userDir, issues) {
	const records = [];
	for (const dirName of TAURITAVERN_PRESET_DIRS) {
		const dir = path.join(userDir, dirName);
		const files = (await listFiles(dir)).filter((name) => name.toLowerCase().endsWith(".json"));
		for (const file of files) {
			const filePath = path.join(dir, file);
			const source = relativeTo(userDir, filePath);
			try {
				const raw = JSON.parse(stripBom(await promises.readFile(filePath, "utf8")));
				const rawName = raw?.name;
				const name = typeof rawName === "string" && rawName.trim() !== "" ? rawName : path.basename(file, ".json");
				const preset = importPreset(raw, newId("preset"), name);
				records.push({
					...preset,
					source
				});
			} catch (error) {
				issues.push({
					category: "preset",
					file: source,
					reason: errorMessage(error)
				});
			}
		}
	}
	return records;
}
/** Normalize an optional boolean selection: absent means true, false disables. */
function selected(value) {
	return value !== false;
}
/**
* Import supported TauriTavern user data from a local installation/data
* directory into the tavern settings store.
*/
async function importTauriTavernData(storage, avatars, input, selection = {}) {
	const categories = {
		characters: selected(selection.characters),
		lorebooks: selected(selection.lorebooks),
		presets: selected(selection.presets)
	};
	if (!categories.characters && !categories.lorebooks && !categories.presets) throw new Error("请至少选择一种要导入的数据");
	const resolved = await resolveTauriTavernDirectory(input);
	if (!await hasSupportedUserData(resolved.userDir)) throw new Error(`目录 ${resolved.userDir} 中未找到 TauriTavern 数据（characters / worlds / 预设目录）`);
	const db = storage.snapshot();
	const issues = [];
	const report = {
		input: resolved.input,
		root: resolved.root,
		userDir: resolved.userDir,
		imported: {
			characters: 0,
			lorebooks: 0,
			presets: 0
		},
		issues
	};
	if (categories.characters) {
		const imported = dedupeBySource(db.characters, await importCharacters(resolved.userDir, path.join(resolved.userDir, "characters"), issues));
		const records = await avatars.materializeCharacters(imported);
		await storage.appendCharacters(records);
		report.imported.characters = records.length;
	}
	if (categories.lorebooks) {
		const records = dedupeLorebooks(db.lorebooks, await importLorebooks(resolved.userDir, path.join(resolved.userDir, "worlds"), issues));
		await storage.appendLorebooks(records);
		report.imported.lorebooks = records.length;
	}
	if (categories.presets) {
		const records = dedupePresets(db.presets, await importPresets(resolved.userDir, issues));
		await storage.appendPresets(records);
		report.imported.presets = records.length;
	}
	return report;
}
//#endregion
//#region src/api.ts
/** Read and JSON-parse a request body (bounded). */
function readJsonBody(req, limit = 16777216) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let total = 0;
		req.on("data", (chunk) => {
			total += chunk.length;
			if (total > limit) {
				reject(/* @__PURE__ */ new Error("请求体过大"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			try {
				const text = Buffer.concat(chunks).toString("utf8");
				resolve(text === "" ? void 0 : JSON.parse(text));
			} catch (error) {
				reject(error);
			}
		});
		req.on("error", reject);
	});
}
function sendJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(payload),
		"cache-control": "no-store"
	});
	res.end(payload);
}
function sendError(res, status, message) {
	sendJson(res, status, { error: message });
}
/** Build a safe Content-Disposition header value for both ASCII and UTF-8 filenames. */
function contentDisposition(filename) {
	const safe = filename.replace(/[\\/:*?"<>|\r\n]/g, "_");
	return `attachment; filename="${safe.replace(/[^\x20-\x7E]/g, "_") || "download"}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}
/** Split `/tavern/...` pathname into segments. */
function segments(pathname) {
	return pathname.split("/").filter((segment) => segment !== "");
}
const PRESET_NUMBER_KEYS = [
	"maxTokens",
	"temperature",
	"topP",
	"topK",
	"topA",
	"typicalP",
	"minP",
	"repPen",
	"repPenRange",
	"repPenSlope",
	"presencePenalty",
	"frequencyPenalty"
];
/** Merge a preset PATCH. `null` clears a field; undefined means "not provided". */
function patchPreset(existing, body) {
	const updated = { ...existing };
	if (typeof body.name === "string" && body.name.trim() !== "") updated.name = body.name;
	for (const key of ["model", "provider"]) {
		const value = body[key];
		if (value === void 0) continue;
		if (value === null || typeof value === "string" && value.trim() === "") delete updated[key];
		else if (typeof value === "string") updated[key] = value.trim();
	}
	if (body.systemPrompt !== void 0) {
		if (body.systemPrompt === null || typeof body.systemPrompt === "string" && body.systemPrompt.trim() === "") delete updated.systemPrompt;
		else if (typeof body.systemPrompt === "string") updated.systemPrompt = body.systemPrompt;
	}
	for (const key of PRESET_NUMBER_KEYS) {
		const value = body[key];
		if (value === void 0) continue;
		if (value === null) delete updated[key];
		else if (typeof value === "number" && Number.isFinite(value)) updated[key] = value;
	}
	if (typeof body.raw === "object" && body.raw !== null) updated.raw = body.raw;
	updated.updatedAt = nowIso();
	return updated;
}
/** The prefix-route handler for /tavern. */
async function tavernHandler(deps, req, res) {
	const { storage, runtime } = deps;
	const seg = segments(new URL(req.url ?? "/", "http://x").pathname);
	const method = req.method ?? "GET";
	try {
		if ((seg.length === 1 || seg.length === 2 && seg[1] === "state") && method === "GET") {
			const plays = storage.listPlays();
			return sendJson(res, 200, {
				characters: storage.listCharacters(),
				lorebooks: storage.listLorebooks(),
				presets: storage.listPresets(),
				plays: plays.map((play) => ({
					id: play.id,
					title: play.title,
					characterIds: play.characterIds,
					lorebookIds: playLorebookIds(play),
					narratorEnabled: play.narratorEnabled,
					multiAgent: play.multiAgent,
					sessionId: play.sessionId,
					live: runtime.getDirector(play.id) !== void 0,
					updatedAt: play.updatedAt
				})),
				defaultPresetId: storage.snapshot().defaultPresetId,
				style: storage.snapshot().style,
				multiAgentAvailable: deps.multiAgentAvailable()
			});
		}
		const importBase = seg[0] === "tavern" ? 1 : 0;
		if (method === "POST" && seg.length === importBase + 2 && seg[importBase] === "import" && seg[importBase + 1] === "tauritavern") {
			const body = await readJsonBody(req);
			if (body === void 0) return sendError(res, 400, "缺少请求体");
			if (typeof body.path !== "string" || body.path.trim() === "") return sendError(res, 400, "缺少 TauriTavern 目录路径");
			try {
				return sendJson(res, 200, await importTauriTavernData(storage, deps.avatars, body.path, {
					characters: typeof body.characters === "boolean" ? body.characters : void 0,
					lorebooks: typeof body.lorebooks === "boolean" ? body.lorebooks : void 0,
					presets: typeof body.presets === "boolean" ? body.presets : void 0
				}));
			} catch (error) {
				return sendError(res, 400, error instanceof Error ? error.message : String(error));
			}
		}
		if (seg[1] === "avatars" && seg.length === 3 && method === "GET") {
			const avatar = await deps.avatars.read(seg[2]);
			if (avatar === void 0) return sendError(res, 404, "头像不存在");
			res.writeHead(200, {
				"content-type": avatar.contentType,
				"content-length": avatar.bytes.length,
				"cache-control": "private, max-age=3600"
			});
			res.end(avatar.bytes);
			return;
		}
		if (seg[1] === "characters") {
			if (seg.length === 2 && method === "POST") {
				const body = await readJsonBody(req);
				if (body === void 0) return sendError(res, 400, "缺少请求体");
				const input = typeof body.input === "string" ? body.input : typeof body.input === "object" ? JSON.stringify(body.input) : void 0;
				if (input === void 0 && typeof body.card === "object" && body.card !== null) {
					const card = normalizeCard(body.card);
					const record = {
						id: newId("char"),
						source: typeof body.source === "string" ? body.source : "manual",
						...typeof body.avatar === "string" ? { avatar: body.avatar } : {},
						createdAt: nowIso(),
						updatedAt: nowIso(),
						card
					};
					const stored = await deps.avatars.materializeCharacter(record);
					await storage.upsertCharacter(stored);
					return sendJson(res, 201, stored);
				}
				if (input === void 0 || input.trim() === "") return sendError(res, 400, "缺少卡片输入");
				const bytes = typeof body.input === "string" && body.input.startsWith("data:") ? Buffer.from(body.input.split(",")[1] ?? "", "base64") : Buffer.from(input, "utf8");
				const card = parseCardInput(bytes, typeof body.source === "string" ? body.source : void 0);
				const avatar = avatarDataUrl(bytes);
				const record = {
					id: newId("char"),
					source: typeof body.source === "string" ? body.source : "upload",
					...avatar !== void 0 ? { avatar } : {},
					createdAt: nowIso(),
					updatedAt: nowIso(),
					card
				};
				const stored = await deps.avatars.materializeCharacter(record);
				await storage.upsertCharacter(stored);
				return sendJson(res, 201, stored);
			}
			if (seg.length === 3 && method === "PUT") {
				const body = await readJsonBody(req);
				const existing = storage.getCharacter(seg[2]);
				if (existing === void 0) return sendError(res, 404, "角色不存在");
				const incoming = typeof body?.data === "object" && body.data !== null ? body.data : {};
				const data = {
					...existing.card.data,
					...incoming
				};
				const card = normalizeCard({
					spec: existing.card.spec,
					spec_version: existing.card.spec_version,
					data
				});
				const updated = {
					...existing,
					...typeof body?.avatar === "string" ? { avatar: body.avatar } : {},
					card,
					updatedAt: nowIso()
				};
				const stored = await deps.avatars.materializeCharacter(updated, existing);
				await storage.upsertCharacter(stored);
				return sendJson(res, 200, stored);
			}
			if (seg.length === 3 && method === "DELETE") {
				const existing = storage.getCharacter(seg[2]);
				if (existing === void 0) return sendError(res, 404, "角色不存在");
				await storage.deleteCharacter(seg[2]);
				await deps.avatars.removeCharacter(existing);
				return sendJson(res, 200, { ok: true });
			}
			if (seg.length === 4 && seg[3] === "export" && method === "GET") {
				const character = storage.getCharacter(seg[2]);
				if (character === void 0) return sendError(res, 404, "角色不存在");
				const avatar = await deps.avatars.readCharacter(character);
				const png = encodePngCard(JSON.stringify(character.card), avatar);
				const name = character.card.data.name.replace(/[\\/:*?"<>|]/g, "_") || "character";
				res.writeHead(200, {
					"content-type": "image/png",
					"content-length": png.length,
					"content-disposition": contentDisposition(`${name}.png`)
				});
				res.end(png);
				return;
			}
		}
		if (seg[1] === "lorebooks") {
			if (seg.length === 2 && method === "POST") {
				const body = await readJsonBody(req);
				if (body === void 0) return sendError(res, 400, "缺少请求体");
				let book;
				let name = typeof body.name === "string" && body.name !== "" ? body.name : "未命名世界书";
				const bookObj = body.book;
				if (typeof bookObj === "object" && bookObj !== null) {
					book = normalizeWorldBook(bookObj);
					const bookName = bookObj.name;
					if (typeof bookName === "string" && bookName !== "") name = bookName;
				} else if (typeof body.input === "string") book = normalizeWorldBook(JSON.parse(body.input));
				else return sendError(res, 400, "缺少世界书内容");
				const record = {
					id: newId("book"),
					name,
					createdAt: nowIso(),
					updatedAt: nowIso(),
					book
				};
				await storage.upsertLorebook(record);
				return sendJson(res, 201, record);
			}
			if (seg.length === 3 && method === "PUT") {
				const body = await readJsonBody(req);
				const existing = storage.getLorebook(seg[2]);
				if (existing === void 0) return sendError(res, 404, "世界书不存在");
				if (typeof body?.book !== "object" || body.book === null) return sendError(res, 400, "缺少世界书内容");
				const book = normalizeWorldBook(body.book);
				const updated = {
					...existing,
					name: typeof body?.name === "string" && body.name !== "" ? body.name : existing.name,
					book,
					updatedAt: nowIso()
				};
				await storage.upsertLorebook(updated);
				return sendJson(res, 200, updated);
			}
			if (seg.length === 3 && method === "DELETE") {
				await storage.deleteLorebook(seg[2]);
				return sendJson(res, 200, { ok: true });
			}
			if (seg.length === 4 && seg[3] === "export" && method === "GET") {
				const record = storage.getLorebook(seg[2]);
				if (record === void 0) return sendError(res, 404, "世界书不存在");
				const payload = JSON.stringify(serializeWorldBookFile(record.book), null, 2);
				const name = record.name.replace(/[\\/:*?"<>|]/g, "_") || "lorebook";
				res.writeHead(200, {
					"content-type": "application/json; charset=utf-8",
					"content-length": Buffer.byteLength(payload),
					"content-disposition": contentDisposition(`${name}.json`)
				});
				res.end(payload);
				return;
			}
		}
		if (seg[1] === "presets") {
			if (seg.length === 2 && method === "POST") {
				const body = await readJsonBody(req);
				if (body === void 0) return sendError(res, 400, "缺少请求体");
				const rawPreset = body.preset ?? body.raw ?? {};
				const presetInput = typeof rawPreset === "string" ? JSON.parse(rawPreset) : rawPreset;
				const rawName = typeof presetInput === "object" && presetInput !== null ? presetInput.name : void 0;
				const name = typeof body.name === "string" && body.name !== "" ? body.name : typeof rawName === "string" && rawName !== "" ? rawName : "未命名预设";
				const preset = importPreset(presetInput, newId("preset"), name);
				await storage.upsertPreset(preset);
				return sendJson(res, 201, preset);
			}
			if (seg.length === 3 && method === "PUT") {
				const body = await readJsonBody(req);
				if (body === void 0) return sendError(res, 400, "缺少请求体");
				const existing = storage.getPreset(seg[2]);
				if (existing === void 0) return sendError(res, 404, "预设不存在");
				const updated = patchPreset(existing, body);
				await storage.upsertPreset(updated);
				return sendJson(res, 200, updated);
			}
			if (seg.length === 3 && method === "DELETE") {
				await storage.deletePreset(seg[2]);
				return sendJson(res, 200, { ok: true });
			}
			if (seg.length === 4 && seg[3] === "export" && method === "GET") {
				const preset = storage.getPreset(seg[2]);
				if (preset === void 0) return sendError(res, 404, "预设不存在");
				const payload = JSON.stringify(serializePreset(preset), null, 2);
				const name = preset.name.replace(/[\\/:*?"<>|]/g, "_") || "preset";
				res.writeHead(200, {
					"content-type": "application/json; charset=utf-8",
					"content-length": Buffer.byteLength(payload),
					"content-disposition": contentDisposition(`${name}.json`)
				});
				res.end(payload);
				return;
			}
		}
		if (seg[1] === "plays") {
			if (seg.length === 2 && method === "POST") {
				const body = await readJsonBody(req);
				if (body === void 0 || !Array.isArray(body.characterIds) || body.characterIds.length === 0) return sendError(res, 400, "需要至少一个角色");
				if (body.characterIds.some((id) => typeof id !== "string")) return sendError(res, 400, "角色 id 必须是字符串");
				const characters = storage.listCharacters();
				for (const id of body.characterIds) if (!characters.some((c) => c.id === id)) return sendError(res, 400, `角色不存在：${id}`);
				const lorebookIds = Array.isArray(body.lorebookIds) ? [...new Set(body.lorebookIds)] : typeof body.lorebookId === "string" ? [body.lorebookId] : [];
				if (body.lorebookIds !== void 0 && !Array.isArray(body.lorebookIds)) return sendError(res, 400, "世界书 id 必须是数组");
				if (lorebookIds.some((id) => typeof id !== "string" || id === "")) return sendError(res, 400, "世界书 id 必须是字符串");
				for (const id of lorebookIds) if (storage.getLorebook(id) === void 0) return sendError(res, 400, `世界书不存在：${id}`);
				if (body.presetId !== void 0 && storage.getPreset(body.presetId) === void 0) return sendError(res, 400, `预设不存在：${body.presetId}`);
				const mainData = characters.find((c) => c.id === body.characterIds[0])?.card.data;
				const greetings = mainData !== void 0 ? [mainData.first_mes, ...mainData.alternate_greetings ?? []].filter((g) => g !== "") : [];
				const greetingIndex = typeof body.greetingIndex === "number" && Number.isInteger(body.greetingIndex) ? body.greetingIndex : 0;
				const title = typeof body.title === "string" && body.title.trim() !== "" ? body.title.trim() : mainData?.name ?? "新酒馆";
				const sessionId = `tavern-${newId("play").replace("play-", "")}`;
				const play = {
					id: newId("play"),
					title,
					characterIds: body.characterIds,
					lorebookIds,
					presetId: body.presetId,
					narratorEnabled: body.narratorEnabled ?? false,
					multiAgent: body.multiAgent ?? false,
					sessionId,
					greetingIndex,
					...greetings[greetingIndex] !== void 0 ? { greeting: greetings[greetingIndex] } : {},
					createdAt: nowIso(),
					updatedAt: nowIso()
				};
				await storage.upsertPlay(play);
				try {
					await runtime.ensureDirector(play);
				} catch (error) {
					await storage.deletePlay(play.id);
					throw error;
				}
				return sendJson(res, 201, play);
			}
			if (seg.length === 3 && method === "GET") {
				const play = storage.getPlay(seg[2]);
				if (play === void 0) return sendError(res, 404, "酒馆会话不存在");
				return sendJson(res, 200, play);
			}
			if (seg.length === 4 && seg[3] === "activate" && method === "POST") {
				const play = storage.getPlay(seg[2]);
				if (play === void 0) return sendError(res, 404, "酒馆会话不存在");
				await runtime.ensureDirector(play);
				return sendJson(res, 200, play);
			}
			if (seg.length === 3 && method === "PUT") {
				const body = await readJsonBody(req);
				if (body === void 0) return sendError(res, 400, "缺少请求体");
				const existing = storage.getPlay(seg[2]);
				if (existing === void 0) return sendError(res, 404, "酒馆会话不存在");
				const characterIds = Array.isArray(body.characterIds) ? body.characterIds : existing.characterIds;
				if (characterIds.length === 0) return sendError(res, 400, "需要至少一个角色");
				if (characterIds.some((id) => typeof id !== "string")) return sendError(res, 400, "角色 id 必须是字符串");
				const characters = storage.listCharacters();
				for (const id of characterIds) if (!characters.some((c) => c.id === id)) return sendError(res, 400, `角色不存在：${id}`);
				let lorebookIds = playLorebookIds(existing);
				if (body.lorebookIds !== void 0) {
					if (!Array.isArray(body.lorebookIds)) return sendError(res, 400, "世界书 id 必须是数组");
					if (body.lorebookIds.some((id) => typeof id !== "string" || id === "")) return sendError(res, 400, "世界书 id 必须是字符串");
					lorebookIds = [...new Set(body.lorebookIds)];
				} else if (typeof body.lorebookId === "string") lorebookIds = [body.lorebookId];
				for (const id of lorebookIds) if (storage.getLorebook(id) === void 0) return sendError(res, 400, `世界书不存在：${id}`);
				if (typeof body.presetId === "string" && storage.getPreset(body.presetId) === void 0) return sendError(res, 400, `预设不存在：${body.presetId}`);
				const updated = {
					...existing,
					...typeof body.title === "string" && body.title.trim() !== "" ? { title: body.title.trim() } : {},
					characterIds,
					lorebookIds,
					...typeof body.presetId === "string" ? { presetId: body.presetId } : {},
					...typeof body.narratorEnabled === "boolean" ? { narratorEnabled: body.narratorEnabled } : {},
					...typeof body.multiAgent === "boolean" ? { multiAgent: body.multiAgent } : {},
					updatedAt: nowIso()
				};
				delete updated.lorebookId;
				await storage.upsertPlay(updated);
				return sendJson(res, 200, updated);
			}
			if (seg.length === 3 && method === "DELETE") {
				await runtime.dropPlay(seg[2]);
				await storage.deletePlay(seg[2]);
				return sendJson(res, 200, { ok: true });
			}
		}
		if (seg[1] === "settings" && seg.length === 2 && method === "PUT") {
			const body = await readJsonBody(req);
			if (body === void 0) return sendError(res, 400, "缺少请求体");
			if ("defaultPresetId" in body) {
				const defaultPresetId = typeof body.defaultPresetId === "string" && body.defaultPresetId !== "" ? body.defaultPresetId : void 0;
				await storage.setDefaultPreset(defaultPresetId);
			}
			if (body.style === "dsh" || body.style === "classic") await storage.setStyle(body.style);
			return sendJson(res, 200, { ok: true });
		}
		return sendError(res, 404, "未知接口");
	} catch (error) {
		if (error instanceof SyntaxError) return sendError(res, 400, `JSON 格式错误：${error.message}`);
		deps.logger.warn(`tavern api error: ${String(error)}`);
		return sendError(res, 500, error instanceof Error ? error.message : String(error));
	}
}
//#endregion
//#region src/index.ts
const name = "dsh-tavern";
/** Services required by the host half. */
const inject = [
	"webServer",
	"settings",
	"agents",
	"agentDefaultModel",
	"tools",
	"dshHomePath",
	"agentPresets",
	"workspaceRegistry",
	"sessionPersistence"
];
/** The settings namespace brand for the tavern document. */
const tavernNamespace = "tavern";
/**
* Schema of the tavern settings namespace (one document per installation).
* A hand-rolled permissive Standard-Schema callable: out-of-tree plugins
* cannot resolve @deepseek-ai runtime packages, so the schema carries no
* schemastery dependency. It validates the version marker and fills missing
* top-level arrays, accepting unknown fields for forward compatibility.
*/
const TavernSchema = Object.assign((input) => {
	if (input === void 0 || input === null) return EMPTY_DATABASE;
	if (typeof input !== "object" || Array.isArray(input)) throw new Error("酒馆数据必须是对象");
	const doc = input;
	if (doc.version !== void 0 && doc.version !== 1) throw new Error(`不支持的酒馆数据版本：${String(doc.version)}`);
	return {
		version: 1,
		characters: Array.isArray(doc.characters) ? doc.characters : [],
		lorebooks: Array.isArray(doc.lorebooks) ? doc.lorebooks : [],
		presets: Array.isArray(doc.presets) ? doc.presets : [],
		plays: Array.isArray(doc.plays) ? doc.plays : [],
		defaultPresetId: doc.defaultPresetId,
		style: doc.style === "dsh" || doc.style === "classic" ? doc.style : void 0
	};
}, { toJSON: () => ({
	type: "object",
	properties: {}
}) });
/**
* Run one async factory at most once per process; a rejection clears the
* memo so the next caller retries.
*/
function memoize(factory) {
	let pending;
	return () => {
		pending ??= factory().catch((error) => {
			pending = void 0;
			throw error;
		});
		return pending;
	};
}
/**
* The tavern service: library CRUD and the session runtime. The browser
* talks to the REST route; other host plugins may use this service directly.
*/
var TavernService = class {
	storage;
	runtime;
	avatars;
	ctx;
	constructor(ctx, settingsScope, avatars) {
		this.ctx = ctx;
		this.storage = new TavernStorage(settingsScope);
		this.avatars = avatars;
		const ensurePreset = memoize(() => ensureTavernPreset(ctx.dshHomePath));
		this.runtime = new TavernSessionRuntime({
			storage: this.storage,
			agents: ctx.agents,
			agentPresets: ctx.agentPresets,
			workspace: ctx.workspaceRegistry,
			sessionPersistence: ctx.sessionPersistence,
			ensurePreset,
			defaultModel: () => {
				const selection = ctx.agentDefaultModel.currentSelection();
				return {
					provider: selection.provider,
					model: selection.model,
					reasoningEffort: selection.reasoningEffort
				};
			},
			logger: ctx.logger
		});
	}
	/** All stored characters. */
	listCharacters() {
		return this.storage.listCharacters();
	}
	/** All stored world books. */
	listLorebooks() {
		return this.storage.listLorebooks();
	}
	/** All stored presets. */
	listPresets() {
		return this.storage.listPresets();
	}
	/** All stored plays. */
	listPlays() {
		return this.storage.listPlays();
	}
	/**
	* Import TauriTavern user data from a local installation/data directory
	* (portable app root, data root, default-user, or a child directory).
	*/
	importTauriTavern(input, selection) {
		return importTauriTavernData(this.storage, this.avatars, input, selection);
	}
	/**
	* One-time (idempotent) migration: extract legacy inline data-URL avatars to
	* `<dsh-home>/tavern/avatars/` and persist only their relative paths.
	*/
	async migrateLegacyAvatars() {
		const db = this.storage.snapshot();
		if (db.characters.length === 0) return { changed: 0 };
		const result = await this.avatars.migrateLegacyCharacters(db.characters);
		if (result.changed === 0) return result;
		await this.storage.replaceCharacters(result.characters);
		return result;
	}
	/**
	* Whether the agent-loop factory is currently available.
	* `AgentRegistry` has no public factory probe; the stock agent-loop plugin
	* provides the public `agentLoop` Cordis service and registers itself as the
	* factory from that service's effect, so this is the reliable public signal.
	*/
	multiAgentAvailable() {
		if (this.ctx.get("agentLoop") !== void 0) return true;
		return this.ctx.agents.factory !== void 0;
	}
};
/** The `tavern_speak` tool: route a character's line through its own agent. */
function defineSpeakTool(service) {
	return {
		name: "tavern_speak",
		description: "让在场角色说出台词。传入角色名或角色 id（两者可选，都不传时使用第一个在场角色），以及你想让角色表达的内容、情绪或所处情境；工具会让该角色以自身的性格与记忆回应，并返回其台词。",
		parameters: {
			type: "object",
			properties: {
				characterName: {
					type: "string",
					description: "在场角色的名字"
				},
				characterId: {
					type: "string",
					description: "角色的内部 id（可选，与 characterName 二选一）"
				},
				instruction: {
					type: "string",
					description: "你想让角色表达的内容、情绪或当前情境"
				}
			},
			required: []
		},
		output: {
			schema: {
				type: "object",
				properties: { reply: {
					type: "string",
					description: "角色说出的台词"
				} },
				required: ["reply"],
				additionalProperties: false
			},
			render: (args, value) => {
				return [{
					type: "text",
					text: `${args.characterName ?? "角色"}：${value.reply ?? ""}`
				}];
			}
		},
		execute: async (args, exec) => {
			const typed = args;
			return service.runtime.speakFor(exec, typed);
		}
	};
}
/** Plugin entry: registers the settings namespace, the tool, and the route. */
function apply(ctx) {
	const service = new TavernService(ctx, ctx.settings.register(tavernNamespace, TavernSchema), new AvatarStore(ctx.dshHomePath("tavern", "avatars"), ctx.logger));
	ctx.provide("tavern", service);
	ensureTavernPreset(ctx.dshHomePath).catch((error) => {
		ctx.logger.warn("tavern: agent preset authoring failed: %s", String(error));
	});
	service.migrateLegacyAvatars().then(({ changed }) => {
		if (changed > 0) ctx.logger.info("tavern avatar migration: extracted %s avatar file(s)", String(changed));
	}).catch((error) => {
		ctx.logger.warn("tavern avatar migration failed: %s", String(error));
	});
	ctx.tools.register(defineSpeakTool(service));
	ctx.effect(() => ctx.webServer.register({
		kind: "prefix",
		path: "/tavern",
		handler: (req, res) => tavernHandler({
			storage: service.storage,
			runtime: service.runtime,
			avatars: service.avatars,
			logger: ctx.logger,
			multiAgentAvailable: () => service.multiAgentAvailable()
		}, req, res)
	}), "tavern.webServer.route");
	ctx.effect(() => () => {
		service.runtime.dispose();
	}, "tavern.runtime.dispose");
}
//#endregion
export { TavernSchema, TavernService, apply, inject, name };
