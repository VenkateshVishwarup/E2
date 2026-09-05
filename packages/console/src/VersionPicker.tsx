export function VersionPicker(
  { label, versions, value, onChange, disabled, exclude }: {
    label: string;
    versions: number[];
    value: number;
    onChange: (v: number) => void;
    disabled?: boolean;
    /** Hide a version already chosen for the other side of a comparison. */
    exclude?: number;
  },
) {
  return (
    <label className="picker">
      <span className="picker-label">{label}</span>
      <select value={value} disabled={disabled}
              onChange={(e) => onChange(Number(e.target.value))}>
        {versions.filter((v) => v !== exclude).map((v) => (
          <option key={v} value={v}>v{v}</option>
        ))}
      </select>
    </label>
  );
}
