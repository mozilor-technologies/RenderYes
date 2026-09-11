import { ViewPage, type ViewPageProps } from "./page.js";

/**
 * RenderYes as a full page, under its original name.
 *
 * `ViewPage` is the same component: it grew the ability to take a custom
 * arrangement as children, which made "workspace" the wrong word for it — the
 * container is a page whether or not it holds the standard workspace layout.
 *
 * Kept as an export because hosts are mounting it, and a rename is not worth a
 * migration on its own. Identical behaviour, identical props.
 */
export const ViewWorkspace = ViewPage;

export type ViewWorkspaceProps = ViewPageProps;
