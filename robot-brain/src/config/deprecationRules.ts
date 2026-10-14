export type InspectLanguage = "typescript" | "python" | "go" | "java";

export interface DeprecationRule {
    packageName: string;
    symbol?: string;
    language: InspectLanguage;
    kind: "import" | "symbol";
    requiresImport?: boolean;
    deprecatedInVersion?: string;
    targetVersion?: string;
    description: string;
    migrationHint: string;
    linePattern?: RegExp;
}

/**
 * Conservative, curated set of well-known deprecated imports and SDK method
 * patterns. Import rules match the module specifier; symbol rules are tested
 * against each code line (optionally gated on the owning package being
 * imported). Kept intentionally small to avoid false positives.
 */
export const DEPRECATION_RULES: readonly DeprecationRule[] = [
    // -------- TypeScript / JavaScript --------
    {
        packageName: "react-dom",
        symbol: "ReactDOM.render",
        language: "typescript",
        kind: "symbol",
        requiresImport: true,
        deprecatedInVersion: "18",
        targetVersion: "19",
        description: "ReactDOM.render was removed in React 19 — use createRoot instead.",
        migrationHint: "import { createRoot } from 'react-dom/client'; createRoot(container).render(<App />);",
        linePattern: /ReactDOM\s*\.\s*render\s*\(/
    },
    {
        packageName: "url",
        symbol: "url.parse",
        language: "typescript",
        kind: "symbol",
        deprecatedInVersion: "11",
        description: "url.parse() is deprecated — use the WHATWG URL API instead.",
        migrationHint: "new URL(input, base)",
        linePattern: /url\s*\.\s*parse\s*\(/
    },
    {
        packageName: "util",
        symbol: "util._extend",
        language: "typescript",
        kind: "symbol",
        description: "util._extend is deprecated — use Object.assign instead.",
        migrationHint: "Object.assign(target, source)",
        linePattern: /util\s*\.\s*_extend\s*\(/
    },
    {
        packageName: "express",
        symbol: "res.sendfile",
        language: "typescript",
        kind: "symbol",
        deprecatedInVersion: "4.0",
        description: "res.sendfile() is deprecated — use res.sendFile() instead.",
        migrationHint: "res.sendFile(path, options)",
        linePattern: /\.\s*sendfile\s*\(/
    },
    {
        packageName: "buffer",
        symbol: "new Buffer",
        language: "typescript",
        kind: "symbol",
        description: "new Buffer() is deprecated — use Buffer.from() instead.",
        migrationHint: "Buffer.from(value)",
        linePattern: /\bnew\s+Buffer\s*\(/
    },

    // -------- Python --------
    {
        packageName: "imp",
        language: "python",
        kind: "import",
        deprecatedInVersion: "3.4",
        description: "The imp module is deprecated (removed in Python 3.12) — use importlib instead.",
        migrationHint: "import importlib"
    },
    {
        packageName: "cgi",
        language: "python",
        kind: "import",
        deprecatedInVersion: "3.11",
        description: "The cgi module is deprecated (removed in Python 3.13) — use a modern framework or email.message.",
        migrationHint: "import email.message"
    },
    {
        packageName: "distutils",
        language: "python",
        kind: "import",
        deprecatedInVersion: "3.10",
        description: "distutils is deprecated (removed in Python 3.12) — use setuptools instead.",
        migrationHint: "from setuptools import setup"
    },
    {
        packageName: "datetime",
        symbol: "datetime.utcnow",
        language: "python",
        kind: "symbol",
        deprecatedInVersion: "3.12",
        description: "datetime.utcnow() is deprecated — use datetime.now(timezone.utc) instead.",
        migrationHint: "datetime.now(timezone.utc)",
        linePattern: /\.utcnow\s*\(/
    },

    // -------- Go --------
    {
        packageName: "io/ioutil",
        language: "go",
        kind: "import",
        deprecatedInVersion: "1.16",
        description: "io/ioutil is deprecated since Go 1.16 — use io and os instead.",
        migrationHint: "Replace ioutil.ReadFile with os.ReadFile and ioutil.ReadAll with io.ReadAll"
    },

    // -------- Java --------
    {
        packageName: "javax.xml.bind",
        language: "java",
        kind: "import",
        deprecatedInVersion: "9",
        targetVersion: "jakarta.xml.bind",
        description: "JAXB (javax.xml.bind) was removed from the JDK in Java 11 — use jakarta.xml.bind instead.",
        migrationHint: "import jakarta.xml.bind.*"
    },
    {
        packageName: "javax.activation",
        language: "java",
        kind: "import",
        deprecatedInVersion: "9",
        targetVersion: "jakarta.activation",
        description: "javax.activation was removed from the JDK in Java 11 — use jakarta.activation instead.",
        migrationHint: "import jakarta.activation.*"
    }
];

export function matchesPackage(importPackage: string, rulePackage: string): boolean {
    return importPackage === rulePackage ||
        importPackage.startsWith(`${rulePackage}.`) ||
        importPackage.startsWith(`${rulePackage}/`);
}
