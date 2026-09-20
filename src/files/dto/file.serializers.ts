/**
 * `fondo_api/serializers.py:FileSerializer` and `File.get_type_display`.
 *
 * ```python
 * class File(models.Model):
 *     FILE_TYPE = ((0, 'proceeding'), (1, 'presentations'))
 *     type = models.IntegerField(choices=FILE_TYPE)
 *
 * class FileSerializer(serializers.ModelSerializer):
 *     type_display = serializers.CharField(source='get_type_display')
 *     class Meta:
 *         model = File
 *         fields = ('id', 'display_name', 'type_display')
 * ```
 */

/** `File.FILE_TYPE`. */
export const FILE_TYPE_CHOICES: ReadonlyMap<bigint, string> = new Map([
  [0n, 'proceeding'],
  [1n, 'presentations'],
]);

/**
 * `get_type_display()` — `force_str(dict(FILE_TYPE).get(value, value), strings_only=True)`.
 *
 * ⚠️ **An unknown type is not an error.** `choices` is not validated on `save()`, so
 * `POST /api/file` with `type=3` or `type=-1` writes the row (measured on the pinned v1), the
 * object lands at `3/<name>`, and the list renders `"type_display": "3"` — the integer itself,
 * because `strings_only=True` returns it unconverted and `CharField` then calls `str()` on it.
 */
export function fileTypeDisplay(type: bigint | number): string {
  const key = BigInt(type);
  return FILE_TYPE_CHOICES.get(key) ?? key.toString();
}

export interface FileRow {
  readonly id: number;
  readonly type: number;
  readonly display_name: string;
}

/** The serialised shape, in `Meta.fields` order — key order is the JSON byte order. */
export interface FileDto {
  readonly id: number;
  readonly display_name: string;
  readonly type_display: string;
}

export function serializeFile(row: FileRow): FileDto {
  return {
    id: row.id,
    display_name: row.display_name,
    type_display: fileTypeDisplay(row.type),
  };
}

export const FILE_ROW_SELECT = { id: true, type: true, display_name: true } as const;
