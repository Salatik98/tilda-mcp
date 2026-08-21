const CANONICAL_STANDARD_FIELD = /^[A-Za-z][A-Za-z0-9_:-]{0,127}$/u;

/**
 * Routing, identity, ordering, publication, and JavaScript meta-properties are
 * never content fields, even when Tilda happens to serialize them as strings.
 */
const UNSAFE_STANDARD_FIELD_TOKENS = new Set([
  "id",
  "pageid",
  "projectid",
  "recordid",
  "blockid",
  "elementid",
  "templateid",
  "parentid",
  "groupid",
  "uid",
  "pid",
  "lid",
  "tpl",
  "tplid",
  "template",
  "type",
  "recordtype",
  "recordcode",
  "code",
  "sort",
  "order",
  "ordinal",
  "index",
  "pos",
  "position",
  "version",
  "revision",
  "status",
  "deleted",
  "hidden",
  "visibility",
  "published",
  "publishedat",
  "changed",
  "created",
  "createdat",
  "updated",
  "updatedat",
  "alias",
  "constructor",
  "prototype",
  "tostring",
  "tolocalestring",
  "valueof",
  "hasownproperty",
  "isprototypeof",
  "propertyisenumerable",
]);

/** One shared fail-closed predicate for generic standard content patches. */
export function isSafeStandardContentField(field: string): boolean {
  if (!CANONICAL_STANDARD_FIELD.test(field)) return false;
  const normalized = field.toLowerCase().replace(/[_:-]/gu, "");
  return !UNSAFE_STANDARD_FIELD_TOKENS.has(normalized);
}
