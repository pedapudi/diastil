/* One navigation door for every document surface.  The shell supplies the
 * active-view policy; outline, comments, problems, and copilot only name the
 * semantic block they mean. */

let navigate: (block: HTMLElement) => void = () => {}

export function configureDocumentNavigation(fn: (block: HTMLElement) => void): void {
  navigate = fn
}

export function navigateToDocumentBlock(block: HTMLElement): void {
  navigate(block)
}

