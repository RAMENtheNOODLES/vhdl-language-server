export function findMatchingParen(text: string, openParenOffset: number): number | null {
    if (openParenOffset < 0 || openParenOffset >= text.length) return null;
    if (text[openParenOffset] !== "(") return null;

    let depth = 0;
    for (let i = openParenOffset; i < text.length; i++) {
        const ch = text[i];
        if (ch === "(") depth++;
        else if (ch === ")") {
            depth--;
            if (depth === 0) return i; // index of ')'
        }
    }
    return null;
}