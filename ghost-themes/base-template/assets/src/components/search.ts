/**
 * Search toggle.
 *
 * Ghost's search UI intercepts data-ghost-search clicks natively.
 * This provides a hook for custom search trigger elements that
 * don't use the data-ghost-search attribute.
 */
export function initSearch(): void {
    const searchButtons = document.querySelectorAll<HTMLButtonElement>(".search-button");

    for (const btn of searchButtons) {
        btn.addEventListener("click", (e: Event) => {
            e.preventDefault();
        });
    }
}
