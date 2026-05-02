import type { FC } from "hono/jsx";

// Simple inline SVG icons for file types
const iconBase = {
  display: "inline-block",
  width: "16px",
  height: "16px",
  verticalAlign: "middle",
};

export const FileGenericIcon: FC = () => (
  <svg style={iconBase} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M9 1H3C2.44772 1 2 1.44772 2 2V14C2 14.5523 2.44772 15 3 15H13C13.5523 15 14 14.5523 14 14V6L9 1Z" stroke="#7ca9f7" strokeWidth="1.5" fill="none"/>
    <path d="M9 1V6H14" stroke="#7ca9f7" strokeWidth="1.5" fill="none"/>
  </svg>
);

export const FileTsIcon: FC = () => (
  <svg style={iconBase} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="2" y="2" width="12" height="12" rx="2" fill="#3178c6"/>
    <text x="8" y="11" textAnchor="middle" fill="white" fontSize="7" fontWeight="bold" fontFamily="system-ui">TS</text>
  </svg>
);

export const FileJsIcon: FC = () => (
  <svg style={iconBase} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="2" y="2" width="12" height="12" rx="2" fill="#f7df1e"/>
    <text x="8" y="11" textAnchor="middle" fill="#323330" fontSize="7" fontWeight="bold" fontFamily="system-ui">JS</text>
  </svg>
);

export const FileReactIcon: FC = () => (
  <svg style={iconBase} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="2" y="2" width="12" height="12" rx="2" fill="#61dafb"/>
    <circle cx="8" cy="8" r="2" fill="#20232a"/>
    <ellipse cx="8" cy="8" rx="5" ry="2" fill="none" stroke="#20232a" strokeWidth="0.8"/>
    <ellipse cx="8" cy="8" rx="5" ry="2" fill="none" stroke="#20232a" strokeWidth="0.8" transform="rotate(60 8 8)"/>
    <ellipse cx="8" cy="8" rx="5" ry="2" fill="none" stroke="#20232a" strokeWidth="0.8" transform="rotate(120 8 8)"/>
  </svg>
);

export const FileJsonIcon: FC = () => (
  <svg style={iconBase} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="2" y="2" width="12" height="12" rx="2" fill="#6b7280"/>
    <text x="8" y="11" textAnchor="middle" fill="white" fontSize="6" fontWeight="bold" fontFamily="monospace">{ }</text>
  </svg>
);

export const FileMarkdownIcon: FC = () => (
  <svg style={iconBase} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="2" y="2" width="12" height="12" rx="2" fill="#8b5cf6"/>
    <text x="8" y="11" textAnchor="middle" fill="white" fontSize="8" fontWeight="bold" fontFamily="system-ui">M</text>
  </svg>
);

export const FileYamlIcon: FC = () => (
  <svg style={iconBase} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="2" y="2" width="12" height="12" rx="2" fill="#cb171e"/>
    <text x="8" y="11" textAnchor="middle" fill="white" fontSize="7" fontWeight="bold" fontFamily="system-ui">Y</text>
  </svg>
);

export const FileCssIcon: FC = () => (
  <svg style={iconBase} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="2" y="2" width="12" height="12" rx="2" fill="#264de4"/>
    <text x="8" y="11" textAnchor="middle" fill="white" fontSize="6" fontWeight="bold" fontFamily="system-ui">CSS</text>
  </svg>
);

export const FileHtmlIcon: FC = () => (
  <svg style={iconBase} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="2" y="2" width="12" height="12" rx="2" fill="#e34c26"/>
    <text x="8" y="11" textAnchor="middle" fill="white" fontSize="6" fontWeight="bold" fontFamily="system-ui">HTML</text>
  </svg>
);

export const FileImageIcon: FC = () => (
  <svg style={iconBase} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="2" y="2" width="12" height="12" rx="2" stroke="#10b981" strokeWidth="1.5" fill="none"/>
    <circle cx="6" cy="6" r="1.5" fill="#10b981"/>
    <path d="M2 12L6 8L9 11L12 8L14 10V13C14 13.5523 13.5523 14 13 14H3C2.44772 14 2 13.5523 2 13V12Z" fill="#10b981"/>
  </svg>
);

export const FileConfigIcon: FC = () => (
  <svg style={iconBase} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="8" cy="8" r="1.5" fill="#6b7280"/>
    <path d="M8 2V4M8 12V14M2 8H4M12 8H14M3.757 3.757L5.172 5.172M10.828 10.828L12.243 12.243M3.757 12.243L5.172 10.828M10.828 5.172L12.243 3.757" stroke="#6b7280" strokeWidth="1.5" strokeLinecap="round"/>
  </svg>
);

export const FileDockerIcon: FC = () => (
  <svg style={iconBase} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="2" y="2" width="12" height="12" rx="2" fill="#2496ed"/>
    <path d="M5 8H6V9H5V8ZM7 8H8V9H7V8ZM9 8H10V9H9V8ZM7 6H8V7H7V6ZM9 6H10V7H9V6ZM11 6H12V7H11V6ZM9 4H10V5H9V4ZM11 4H12V5H11V4ZM13 7H14V8H13V7ZM13 5H14V6H13V5ZM4 10H12V11H4V10Z" fill="white"/>
  </svg>
);

export const FileLockIcon: FC = () => (
  <svg style={iconBase} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="3" y="7" width="10" height="7" rx="1" stroke="#f59e0b" strokeWidth="1.5" fill="none"/>
    <path d="M5 7V5C5 3.34315 6.34315 2 8 2C9.65685 2 11 3.34315 11 5V7" stroke="#f59e0b" strokeWidth="1.5"/>
  </svg>
);

// Folder icons
export const FolderGenericIcon: FC = () => (
  <svg style={iconBase} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M2 4C2 3.44772 2.44772 3 3 3H6L8 5H13C13.5523 5 14 5.44772 14 6V12C14 12.5523 13.5523 13 13 13H3C2.44772 13 2 12.5523 2 12V4Z" stroke="#fbbf24" strokeWidth="1.5" fill="none"/>
  </svg>
);

export const FolderHiddenIcon: FC = () => (
  <svg style={iconBase} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M2 4C2 3.44772 2.44772 3 3 3H6L8 5H13C13.5523 5 14 5.44772 14 6V12C14 12.5523 13.5523 13 13 13H3C2.44772 13 2 12.5523 2 12V4Z" stroke="#6b7280" strokeWidth="1.5" fill="none"/>
    <path d="M6 9C6 9 7 10 8 10C9 10 10 9 10 9M5.5 8L6.5 9M9.5 9L10.5 8" stroke="#6b7280" strokeWidth="1.5" strokeLinecap="round"/>
  </svg>
);

export const FolderSrcIcon: FC = () => (
  <svg style={iconBase} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M2 4C2 3.44772 2.44772 3 3 3H6L8 5H13C13.5523 5 14 5.44772 14 6V12C14 12.5523 13.5523 13 13 13H3C2.44772 13 2 12.5523 2 12V4Z" stroke="#3b82f6" strokeWidth="1.5" fill="none"/>
    <path d="M5 9L7 11L11 7" stroke="#3b82f6" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

export const FolderTestIcon: FC = () => (
  <svg style={iconBase} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M2 4C2 3.44772 2.44772 3 3 3H6L8 5H13C13.5523 5 14 5.44772 14 6V12C14 12.5523 13.5523 13 13 13H3C2.44772 13 2 12.5523 2 12V4Z" stroke="#10b981" strokeWidth="1.5" fill="none"/>
    <circle cx="8" cy="9" r="2" stroke="#10b981" strokeWidth="1.5"/>
  </svg>
);

export const FolderDocsIcon: FC = () => (
  <svg style={iconBase} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M2 4C2 3.44772 2.44772 3 3 3H6L8 5H13C13.5523 5 14 5.44772 14 6V12C14 12.5523 13.5523 13 13 13H3C2.44772 13 2 12.5523 2 12V4Z" stroke="#8b5cf6" strokeWidth="1.5" fill="none"/>
    <path d="M5 7H11M5 9H9M5 11H7" stroke="#8b5cf6" strokeWidth="1.5" strokeLinecap="round"/>
  </svg>
);

export const FolderExamplesIcon: FC = () => (
  <svg style={iconBase} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M2 4C2 3.44772 2.44772 3 3 3H6L8 5H13C13.5523 5 14 5.44772 14 6V12C14 12.5523 13.5523 13 13 13H3C2.44772 13 2 12.5523 2 12V4Z" stroke="#f59e0b" strokeWidth="1.5" fill="none"/>
    <circle cx="8" cy="9" r="1.5" fill="#f59e0b"/>
  </svg>
);

export const FolderScriptsIcon: FC = () => (
  <svg style={iconBase} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M2 4C2 3.44772 2.44772 3 3 3H6L8 5H13C13.5523 5 14 5.44772 14 6V12C14 12.5523 13.5523 13 13 13H3C2.44772 13 2 12.5523 2 12V4Z" stroke="#ec4899" strokeWidth="1.5" fill="none"/>
    <path d="M6 8L8 9L6 10M9 10H11" stroke="#ec4899" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);
