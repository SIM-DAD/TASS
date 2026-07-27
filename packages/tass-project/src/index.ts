/**
 * @simdad/tass-project — the .tassproj reproducible-project container (Modern Build Plan
 * Sections 3.5 and 6/M2). Zero runtime dependencies (node builtins + @simdad/tass-core).
 * Deterministic: the same saved state is the same file, byte for byte; loads are
 * integrity-verified; re-runs must reproduce results byte-identically.
 */
export { crc32, writeZip, readZip } from './zip';
export type { ZipEntry } from './zip';
export { TASSPROJ_SCHEMA, saveProject, loadProject } from './container';
export type { Project, ProjectMeta, RunManifest, SaveOptions } from './container';
export { diffProjects } from './diff';
export type { ProjectDiff, ScoredColumnDelta } from './diff';
export {
    VERDICTS, isVerdict, VALIDATION_MEMBER, isValidationMember, validationId,
    readValidation, writeValidation, deriveMatchUnits, sampleForValidation, partitionValidation,
} from './validation';
export type {
    Verdict, ValidationRecord, MatchUnit, MatchUnitOptions, SampleOptions, ValidationPartition,
} from './validation';
