import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';

import type CopyousExtension from '../../extension.js';
import { ClipboardHistory, ItemType, Tag, getDataPath } from '../common/constants.js';
import { int32ParamSpec, registerClass } from '../common/gjs.js';
import { getLinkImagePath } from './link.js';

export type Metadata = CodeMetadata | FileMetadata | LinkMetadata;

export interface Language {
	id: string;
	name: string;
}

export interface CodeMetadata {
	language: Language | null;
}

export const FileOperation = {
	Copy: 'COPY',
	Cut: 'CUT',
} as const;

export type FileOperation = (typeof FileOperation)[keyof typeof FileOperation];

export interface FileMetadata {
	operation: FileOperation;
}

export interface LinkMetadata {
	title: string | null;
	description: string | null;
	image: string | null;
}

@registerClass({
	Properties: {
		id: int32ParamSpec('id', GObject.ParamFlags.READABLE, 0),
		type: GObject.ParamSpec.string('type', null, null, GObject.ParamFlags.READWRITE, ItemType.Text),
		content: GObject.ParamSpec.string('content', null, null, GObject.ParamFlags.READWRITE, ''),
		pinned: GObject.ParamSpec.boolean('pinned', null, null, GObject.ParamFlags.READWRITE, false),
		tag: GObject.ParamSpec.string('tag', null, null, GObject.ParamFlags.READWRITE, ''),
		datetime: GObject.ParamSpec.boxed('datetime', null, null, GObject.ParamFlags.READWRITE, GLib.DateTime),
		metadata: GObject.ParamSpec.jsobject('metadata', null, null, GObject.ParamFlags.READWRITE),
		title: GObject.ParamSpec.string('title', null, null, GObject.ParamFlags.READWRITE, ''),
	},
	Signals: {
		delete: {},
	},
})
export class ClipboardEntry extends GObject.Object {
	private readonly _id: number;
	declare type: ItemType;
	declare content: string;
	declare pinned: boolean;
	declare tag: Tag | null;
	declare datetime: GLib.DateTime;
	declare metadata: Metadata | null;
	declare title: string;

	constructor(
		id: number,
		type: ItemType,
		content: string,
		pinned: boolean,
		tag: Tag | null,
		datetime: GLib.DateTime,
		metadata: Metadata | null = null,
		title: string = '',
	) {
		super();

		this._id = id;
		this.type = type;
		this.content = content;
		this.pinned = pinned;
		this.tag = tag;
		this.datetime = datetime;
		this.metadata = metadata;
		this.title = title;
	}

	get id() {
		return this._id;
	}
}

export class ClipboardEntryTracker {
	private _database: Database | undefined;
	private _entries: Map<number, ClipboardEntry> = new Map();

	constructor(private ext: CopyousExtension) {}

	async init(): Promise<ClipboardEntry[]> {
		if (this._database) {
			await this.clear();
			await this.destroy();
		}

		const inMemory = this.ext.settings.get_boolean('in-memory-database');
		if (inMemory) {
			this.ext.logger.log('Using in-memory database');
			this._database = new MemoryDatabase();
		} else {
			this.ext.logger.log('Using JSON file database');
			this._database = new JsonFileDatabase(this.ext);
		}
		await this._database.init();
		const entries = await this._database.entries();
		entries.forEach((entry) => this.track(entry));
		await this.deleteOldest();
		return entries;
	}

	public async clear(history: ClipboardHistory | null = null) {
		if (!this._database) return;

		history ??= this.ext.settings.get_enum('clipboard-history') as ClipboardHistory;
		const deleted = await this._database.clear(history);
		deleted.forEach((id) => this.deleteFromDatabase(id));
	}

	public async destroy() {
		await this._database?.close();
		this._database = undefined;
	}

	/**
	 * Inserts an entry into the database
	 * @param type The type of the entry
	 * @param content The content of the entry
	 * @param metadata The metadata of the entry
	 * @returns The inserted entry or null if the entry could not be inserted or is already tracked
	 */
	public async insert(
		type: ItemType,
		content: string,
		metadata: Metadata | null = null,
	): Promise<ClipboardEntry | null> {
		const id = await this._database?.selectConflict({ type, content });
		if (id) {
			// Check if the entry is already tracked
			const trackedEntry = this._entries.get(id);
			if (trackedEntry) {
				trackedEntry.datetime = GLib.DateTime.new_now_utc();
				return null;
			}
		}

		const entry = await this._database?.insert(type, content, metadata);
		if (!entry) return null;

		// Start tracking it
		this.track(entry);

		// Also delete oldest entries
		await this.deleteOldest();

		return entry;
	}

	public checkOldest(): boolean {
		const M = this.ext.settings.get_int('history-time');
		if (M === 0) return false;

		const now = GLib.DateTime.new_now_utc();
		const olderThan = now.add_minutes(-M)!;

		for (const entry of this._entries.values()) {
			if (entry.pinned || entry.tag) continue;
			if (entry.datetime.compare(olderThan) < 0) return true;
		}

		return false;
	}

	public async deleteOldest() {
		const N = this.ext.settings.get_int('history-length');
		const M = this.ext.settings.get_int('history-time');
		const deleted = await this._database?.deleteOldest(N, M);
		if (deleted) deleted.forEach((id) => this.deleteFromDatabase(id));
	}

	private track(entry: ClipboardEntry) {
		entry.connect('notify::content', async () => {
			const id = await this._database?.updateProperty(entry, 'content');
			// If entry conflicts with another entry, delete it
			if (id !== undefined && id >= 0) {
				entry.emit('delete');

				// Update the date of the other entry
				const conflicted = this._entries.get(id);
				if (conflicted) {
					conflicted.datetime = entry.datetime;
				}
			}
		});
		entry.connect('notify::pinned', () => this._database?.updateProperty(entry, 'pinned'));
		entry.connect('notify::tag', () => this._database?.updateProperty(entry, 'tag'));
		entry.connect('notify::datetime', () => this._database?.updateProperty(entry, 'datetime'));
		entry.connect('notify::metadata', () => this._database?.updateProperty(entry, 'metadata'));
		entry.connect('notify::title', () => this._database?.updateProperty(entry, 'title'));
		entry.connect('delete', () => this.delete(entry));
		this._entries?.set(entry.id, entry);
	}

	private async delete(entry: ClipboardEntry) {
		if (entry.type === ItemType.Image) {
			// Delete image
			try {
				const file = Gio.File.new_for_uri(entry.content);
				if (file.query_exists(null)) {
					file.delete(null);
				}
			} catch {
				this.ext.logger.error('Failed to delete image', entry.content);
			}
		} else if (entry.type === ItemType.Link && entry.metadata) {
			// Delete thumbnail image
			const metadata: { image: string | null } = { image: null, ...entry.metadata };
			if (metadata.image) {
				try {
					const file = getLinkImagePath(this.ext, metadata.image);
					if (file?.query_exists(null)) {
						file.delete(null);
					}
				} catch {
					this.ext.logger.error('Failed to delete thumbnail image', metadata.image);
				}
			}
		}

		// Delete from database if not deleted already
		if (this._entries.has(entry.id)) {
			await this._database?.delete(entry);
			this._entries.delete(entry.id);
		}
	}

	private deleteFromDatabase(id: number) {
		const entry = this._entries.get(id);
		if (entry) {
			this._entries.delete(id);
			entry.emit('delete');
		}
	}
}

/**
 * Clipboard database
 */
interface Database {
	/**
	 * Initializes the database
	 */
	init(): Promise<void>;

	/**
	 * Clears the database.
	 * @param history Which items to keep.
	 */
	clear(history: ClipboardHistory): Promise<number[]>;

	/**
	 * Close the connection to the database.
	 */
	close(): Promise<void>;

	/**
	 * Gets the entries of the database.
	 */
	entries(): Promise<ClipboardEntry[]>;

	/**
	 * Select a conflicting entry by its type and content.
	 * @param entry The entry to search its conflict for.
	 * @returns The id of the conflicting entry or null if no conflict was found.
	 */
	selectConflict(entry: ClipboardEntry | { type: ItemType; content: string }): Promise<number | null>;

	/**
	 * Inserts an entry into the database.
	 * @param type The type of the entry.
	 * @param content The content of the entry.
	 * @param metadata Metadata of the entry.
	 */
	insert(type: ItemType, content: string, metadata: Metadata | null): Promise<ClipboardEntry | null>;

	/**
	 * Updates a property of an inserted database entry.
	 * @param entry The entry to update the property of.
	 * @param property The property of the entry to update.
	 * @returns -1 if the property was updates, an id of a conflicting entry otherwise.
	 */
	updateProperty(
		entry: ClipboardEntry,
		property: Exclude<keyof ClipboardEntry, keyof GObject.Object>,
	): Promise<number>;

	/**
	 * Delete an entry from the database.
	 * @param entry The entry to delete.
	 */
	delete(entry: ClipboardEntry): Promise<void>;

	/**
	 * Delete the oldest entries of the database.
	 * @param offset The number of entries to keep.
	 * @param olderThanMinutes Items older than this value will be deleted.
	 * @returns The ids of entries that were deleted.
	 */
	deleteOldest(offset: number, olderThanMinutes: number): Promise<number[]>;
}

/**
 * In memory database
 */
class MemoryDatabase implements Database {
	private _entries: Map<string, ClipboardEntry> = new Map();
	private _keys: Map<number, string> = new Map();
	private _id: number = 0;

	constructor() {}

	public async init(): Promise<void> {}

	public clear(history: ClipboardHistory): Promise<number[]> {
		let deleted: number[] = [];
		switch (history) {
			case ClipboardHistory.Clear:
				deleted = Array.from(this._keys.keys());
				this._entries.clear();
				this._keys.clear();
				break;
			case ClipboardHistory.KeepPinnedAndTagged:
				deleted = [];
				for (const [key, entry] of this._entries) {
					if (!(entry.pinned || entry.tag)) {
						this._entries.delete(key);
						this._keys.delete(entry.id);
						deleted.push(entry.id);
					}
				}
				break;
			case ClipboardHistory.KeepAll:
				break;
		}

		return Promise.resolve(deleted);
	}

	public async close(): Promise<void> {
		await this.clear(ClipboardHistory.Clear);
	}

	public entries(): Promise<ClipboardEntry[]> {
		const entries = Array.from(this._entries.values()).sort((a, b) => b.datetime.compare(a.datetime));
		return Promise.resolve(entries);
	}

	public selectConflict(entry: ClipboardEntry | { type: ItemType; content: string }): Promise<number | null> {
		const key = `${entry.type}:${entry.content}`;
		return Promise.resolve(this._entries.get(key)?.id ?? null);
	}

	public insert(type: ItemType, content: string, metadata: Metadata | null = null): Promise<ClipboardEntry | null> {
		const key = `${type}:${content}`;
		const entry = this._entries.get(key);
		if (entry) {
			return Promise.resolve(null);
		} else {
			const newEntry = new ClipboardEntry(
				this._id++,
				type,
				content,
				false,
				null,
				GLib.DateTime.new_now_utc(),
				metadata,
			);
			this._entries.set(key, newEntry);
			this._keys.set(newEntry.id, key);
			return Promise.resolve(newEntry);
		}
	}

	public updateProperty(
		entry: ClipboardEntry,
		property: Exclude<keyof ClipboardEntry, keyof GObject.Object>,
	): Promise<number> {
		if (property !== 'content') return Promise.resolve(-1);

		const key = `${entry.type}:${entry.content}`;
		const existingEntry = this._entries.get(key);
		if (existingEntry) {
			return Promise.resolve(existingEntry.id);
		} else {
			const prevKey = this._keys.get(entry.id);
			if (prevKey) this._entries.delete(prevKey);

			this._entries.set(key, entry);
			this._keys.set(entry.id, key);
			return Promise.resolve(-1);
		}
	}

	public delete(entry: ClipboardEntry): Promise<void> {
		const key = this._keys.get(entry.id);
		this._keys.delete(entry.id);
		if (key) this._entries.delete(key);

		return Promise.resolve();
	}

	public async deleteOldest(offset: number, olderThanMinutes: number): Promise<number[]> {
		const entries = await this.entries();
		let deleted = entries
			.filter((e) => !(e.pinned || e.tag))
			.map((e) => e.id)
			.slice(offset);

		if (olderThanMinutes > 0) {
			const now = GLib.DateTime.new_now_utc();
			const olderThan = now.add_minutes(-olderThanMinutes)!;
			deleted = [
				...new Set([
					...deleted,
					...entries
						.filter((e) => !(e.pinned || e.tag) && e.datetime.compare(olderThan) < 0)
						.map((e) => e.id),
				]),
			];
		}

		for (const id of deleted) {
			const key = this._keys.get(id);
			this._keys.delete(id);
			if (key) this._entries.delete(key);
		}

		return deleted;
	}
}

interface JsonDbRow {
	id: number;
	type: string;
	content: string;
	pinned: boolean;
	tag: string | null;
	datetime: string;
	metadata: Metadata | null;
	title?: string | undefined;
}

interface JsonDbData {
	version: number;
	nextId: number;
	entries: JsonDbRow[];
}

/**
 * JSON file-backed database — replaces GdaDatabase to avoid libgda6 dependency.
 * Stores clipboard entries as a JSON array in the extension's data directory.
 * Uses atomic file writes (replace_contents) via Gio.File.
 */
class JsonFileDatabase implements Database {
	private _entries: Map<number, ClipboardEntry> = new Map();
	private _keys: Map<string, number> = new Map();
	private _nextId: number = 1;
	private _file: Gio.File;
	private _saveTimeoutId: number = -1;
	private _dirty: boolean = false;

	constructor(private ext: CopyousExtension) {
		const location = this.ext.settings.get_string('database-location');
		if (location) {
			const locFile = Gio.File.new_for_path(location);
			const dir = locFile.get_parent() ?? getDataPath(ext);
			const basename = (locFile.get_basename() ?? 'clipboard').replace(/\.db$/, '') + '.json';
			this._file = dir.get_child(basename);
		} else {
			const dataDir = getDataPath(ext);
			this._file = dataDir.get_child('clipboard.json');
		}
	}

	public async init(): Promise<void> {
		const dir = this._file.get_parent();
		if (dir && !dir.query_exists(null)) {
			dir.make_directory_with_parents(null);
		}

		if (this._file.query_exists(null)) {
			try {
				const [ok, contents] = this._file.load_contents(null);
				if (ok && contents.length > 0) {
					const decoder = new TextDecoder();
					const data = JSON.parse(decoder.decode(contents)) as JsonDbData;
					this._nextId = data.nextId ?? 1;
					for (const row of data.entries ?? []) {
						const datetime = GLib.DateTime.new_from_iso8601(row.datetime, GLib.TimeZone.new_utc());
						if (!datetime) continue;

						let metadata: Metadata | null = null;
						if (row.metadata) {
							try {
								metadata = (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata) as Metadata;
							} catch {
								this.ext.logger.error('Failed to parse metadata for entry', row.id);
							}
						}

						const entry = new ClipboardEntry(
							row.id,
							row.type as ItemType,
							row.content,
							row.pinned ?? false,
							(row.tag as Tag) ?? null,
							datetime,
							metadata,
							row.title ?? '',
						);
						this._entries.set(entry.id, entry);
						this._keys.set(`${entry.type}:${entry.content}`, entry.id);
						if (entry.id >= this._nextId) {
							this._nextId = entry.id + 1;
						}
					}
				}
			} catch (e) {
				this.ext.logger.error('Failed to load JSON database', e);
			}
		}
	}

	public async clear(history: ClipboardHistory): Promise<number[]> {
		let deleted: number[] = [];
		switch (history) {
			case ClipboardHistory.Clear:
				deleted = Array.from(this._entries.keys());
				this._entries.clear();
				this._keys.clear();
				break;
			case ClipboardHistory.KeepPinnedAndTagged:
				for (const [id, entry] of this._entries) {
					if (!(entry.pinned || entry.tag)) {
						this._entries.delete(id);
						this._keys.delete(`${entry.type}:${entry.content}`);
						deleted.push(id);
					}
				}
				break;
			case ClipboardHistory.KeepAll:
				break;
		}

		if (deleted.length > 0) this.scheduleSave();
		return deleted;
	}

	public async close(): Promise<void> {
		if (this._saveTimeoutId >= 0) {
			GLib.source_remove(this._saveTimeoutId);
			this._saveTimeoutId = -1;
		}
		if (this._dirty) {
			this.saveNow();
		}
	}

	public async entries(): Promise<ClipboardEntry[]> {
		return Array.from(this._entries.values()).sort((a, b) => b.datetime.compare(a.datetime));
	}

	public async selectConflict(entry: ClipboardEntry | { type: ItemType; content: string }): Promise<number | null> {
		const key = `${entry.type}:${entry.content}`;
		return this._keys.get(key) ?? null;
	}

	public async insert(
		type: ItemType,
		content: string,
		metadata: Metadata | null = null,
	): Promise<ClipboardEntry | null> {
		const key = `${type}:${content}`;
		if (this._keys.has(key)) {
			return null;
		}

		const id = this._nextId++;
		const datetime = GLib.DateTime.new_now_utc();
		const entry = new ClipboardEntry(id, type, content, false, null, datetime, metadata);
		this._entries.set(id, entry);
		this._keys.set(key, id);
		this.scheduleSave();
		return entry;
	}

	public async updateProperty(
		entry: ClipboardEntry,
		property: Exclude<keyof ClipboardEntry, keyof GObject.Object>,
	): Promise<number> {
		if (property === 'content' || property === 'type') {
			const key = `${entry.type}:${entry.content}`;
			const existingId = this._keys.get(key);
			if (existingId !== undefined && existingId !== entry.id) {
				return existingId;
			}

			for (const [k, v] of this._keys) {
				if (v === entry.id) {
					this._keys.delete(k);
					break;
				}
			}
			this._keys.set(key, entry.id);
		}

		this.scheduleSave();
		return -1;
	}

	public async delete(entry: ClipboardEntry): Promise<void> {
		this._entries.delete(entry.id);
		const key = `${entry.type}:${entry.content}`;
		if (this._keys.get(key) === entry.id) {
			this._keys.delete(key);
		}
		this.scheduleSave();
	}

	public async deleteOldest(offset: number, olderThanMinutes: number): Promise<number[]> {
		const sorted = Array.from(this._entries.values()).sort((a, b) => b.datetime.compare(a.datetime));
		const unpinned = sorted.filter((e) => !(e.pinned || e.tag));

		let deleted = unpinned.slice(offset).map((e) => e.id);

		if (olderThanMinutes > 0) {
			const now = GLib.DateTime.new_now_utc();
			const olderThan = now.add_minutes(-olderThanMinutes)!;
			const timeDeleted = sorted
				.filter((e) => !(e.pinned || e.tag) && e.datetime.compare(olderThan) < 0)
				.map((e) => e.id);
			deleted = [...new Set([...deleted, ...timeDeleted])];
		}

		for (const id of deleted) {
			const entry = this._entries.get(id);
			if (entry) {
				this._entries.delete(id);
				this._keys.delete(`${entry.type}:${entry.content}`);
			}
		}

		if (deleted.length > 0) this.scheduleSave();
		return deleted;
	}

	private scheduleSave(): void {
		this._dirty = true;
		if (this._saveTimeoutId >= 0) return;
		this._saveTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
			this.saveNow();
			this._saveTimeoutId = -1;
			return GLib.SOURCE_REMOVE;
		});
	}

	private saveNow(): void {
		try {
			const data: JsonDbData = {
				version: 1,
				nextId: this._nextId,
				entries: Array.from(this._entries.values()).map((e) => ({
					id: e.id,
					type: e.type,
					content: e.content,
					pinned: e.pinned,
					tag: e.tag,
					datetime: e.datetime.to_utc()!.format_iso8601()!,
					metadata: e.metadata,
					title: e.title || undefined,
				})),
			};

			const encoder = new TextEncoder();
			const bytes = encoder.encode(JSON.stringify(data, null, '\t'));

			const dir = this._file.get_parent();
			if (dir && !dir.query_exists(null)) {
				dir.make_directory_with_parents(null);
			}

			this._file.replace_contents(
				bytes,
				null,
				false,
				Gio.FileCreateFlags.REPLACE_DESTINATION,
				null,
			);
			this._dirty = false;
		} catch (e) {
			this.ext.logger.error('Failed to save JSON database', e);
		}
	}
}
