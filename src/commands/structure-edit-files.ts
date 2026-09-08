import { isJsonObject, type JsonObject } from "../lib/json-types.js";

// Editing preserves fields the operation does not interpret. These views
// promise only the identifiers and collections used to detect duplicates.
interface NamedEntry extends JsonObject { name: string }
interface EditableModule extends JsonObject { id: string; symbols: NamedEntry[] }
interface EditablePublicApi extends JsonObject { modules: EditableModule[] }
interface EditableEnv extends JsonObject { keys: NamedEntry[] }

function isNamedEntry(value: unknown): value is NamedEntry {
	return isJsonObject(value) && typeof value.name === "string";
}

function isEditableModule(value: unknown): value is EditableModule {
	return isJsonObject(value) && typeof value.id === "string"
		&& Array.isArray(value.symbols) && value.symbols.every(isNamedEntry);
}

export function isEditablePublicApi(value: unknown): value is EditablePublicApi {
	return isJsonObject(value) && Array.isArray(value.modules) && value.modules.every(isEditableModule);
}

export function isEditableEnv(value: unknown): value is EditableEnv {
	return isJsonObject(value) && Array.isArray(value.keys) && value.keys.every(isNamedEntry);
}
