/**
 * Membership form state handling.
 *
 * Ghost automatically adds .loading, .success, .error classes to
 * forms with data-members-form. This handles supplemental UI state
 * for custom form elements.
 */
export function initMembersForms(): void {
    const forms = document.querySelectorAll<HTMLFormElement>("[data-members-form]");

    for (const form of forms) {
        form.addEventListener("submit", () => {
            form.classList.add("loading");
        });
    }
}
