/**
 * @module confluence-syncer
 */
import context from './context.js';
import config from './config.js';
import logger from './logger.js';
import ConfluenceSDK from './confluence-sdk.js';
import { Meta, LocalPage } from '../lib/models/index.js';
import AssetRenderer from './renderers/asset-renderer.js';

const confluence = new ConfluenceSDK(config.confluence);

/**
 * Sync local markdown documentation with Confluence
 * 
 * @returns {Promise<void>}
 */
async function sync() {
    try {
        const { siteName, repo, pages: localPages, readMe, pageRefs } = context.getContext();
        const assetRenderer = new AssetRenderer(config, pageRefs);
        const home = await syncHome(repo, siteName, readMe, assetRenderer);
        await syncPages(home, localPages, assetRenderer);
        const rootUrl = `${config.confluence.host}/wiki/spaces/${config.confluence.spaceKey}/pages/${home}`;
        logger.info(`"${siteName}" Documentation published at ${rootUrl}`);
        syncSummary(siteName, rootUrl);
    } catch (error) {
        errorHandler(error);
    }
}

/**
 * Write action summary
 * 
 * @param {string} siteName - The name of the documentation site
 * @param {string} url - The Confluence url of the published documentation
 */
function syncSummary(siteName, url) {
    logger.summary.addHeading(':books: Documentation published', 1)
        .addRaw('View the documentation using the following link')
        .addBreak().addRaw(':link: ')
        .addLink(siteName, url).addEOL()
        .write();
}

/**
 * Handles errors and fails the action
 *  
 * @param {Error} error - The Error that occurred
 */
function errorHandler(error) {
    if (logger.isDebug()) {
        const safeConfig = Object.assign({}, config);
        safeConfig.confluence.token = '***';
        logger.debug(`Config:\n${JSON.stringify(safeConfig, null, 2)}`);
        logger.debug(error.stack);
    }
    logger.fail(error);
}

/**
 * Create or update home page from README.md
 * 
 * @param {string} repo 
 * @param {string} siteName 
 * @param {LocalPage} localPage 
 * @param {AssetRenderer} renderer 
 * @returns {Promise<number>} Home page id
 */
async function syncHome(repo, siteName, localPage, renderer) {
    if (!localPage) {
        localPage = new LocalPage(siteName, new Meta(repo));
        localPage.html = `<h1>${siteName}</h1>`;
    }
    localPage.parentPageId = await findParentPage();
    let homePage = localPage;
    const remotePage = await confluence.findPage(siteName);
    if (remotePage) {
        homePage = remotePage;
        homePage.localPage = localPage;
        // check for potential repo conflict
        if (homePage.repoConflict()) {
            throw new Error(`Page "${siteName}" already exist for another repo "${homePage.meta.repo}"`);
        }
    }
    return homePage.sync(renderer, confluence).then(page => page.id);
}

/**
 * Find the `id` of the Confluence page Configured to be the parent for our documents
 * 
 * @returns {number} The `id` of the configured parent page
 * @throws `Error` if the configured parent page does not exist
 */
async function findParentPage() {
    const title = config.confluence.parentPage;
    if (!title) {
        return;
    }
    const parentPage = await confluence.findPage(title);
    if (!parentPage) {
        throw new Error(`The page configured as parent (${title}) does not exist in confluence`);
    }
    return parentPage.id;
}

/**
 * Sync Local pages with Confluence
 * 
 * @param {number} home - The id of the home page 
 * @param {Array<LocalPage>} localPages - Array of pages
 * @param {AssetRenderer} renderer - `AssetRenderer` instance 
 */
async function syncPages(home, localPages, renderer) {
    // Build a map to track synced pages and their Confluence IDs
    const syncedPages = new Map();
    syncedPages.set(null, home); // root level pages use home as parent
    
    // Group pages by their parent
    const pagesByParent = new Map();
    const sectionPages = new Map(); // Map section titles to their first page
    
    for (const page of localPages) {
        const parentKey = page.parentPath || null;
        if (!pagesByParent.has(parentKey)) {
            pagesByParent.set(parentKey, []);
        }
        pagesByParent.get(parentKey).push(page);
        
        // Track section pages (first page in a section becomes the section parent)
        if (page.parentPath && !sectionPages.has(page.parentPath)) {
            sectionPages.set(page.parentPath, page);
        }
    }
    
    // Sync pages level by level to ensure parents exist before children
    const processLevel = async (parentKey) => {
        const pages = pagesByParent.get(parentKey) || [];
        const parentPageId = syncedPages.get(parentKey);
        
        // Get remote pages for this level
        const remotePages = await confluence.getChildPages(parentPageId);
        const union = [];
        
        for (let localPage of pages) {
            localPage.parentPageId = parentPageId;
            const remotePage = remotePages.get(localPage.meta.path);
            if (!remotePage) {
                union.push(localPage);
                continue;
            }
            remotePages.delete(localPage.meta.path);
            remotePage.localPage = localPage;
            union.push(remotePage);
        }
        
        // Any remaining remote page not matching a local page should be deleted
        for (let remotePage of remotePages.values()) {
            union.push(remotePage);
        }
        
        // Sync all pages at this level
        for (let page of union) {
            const syncedPage = await page.sync(renderer, confluence);
            // Track the synced page for its children to reference
            if (page.title && syncedPage && syncedPage.id) {
                syncedPages.set(page.title, syncedPage.id);
            }
        }
        
        // Now process children of pages at this level
        for (let page of pages) {
            if (sectionPages.get(page.title)) {
                // This page has children (it's a section), process them
                await processLevel(page.title);
            }
        }
    };
    
    // Start processing from root level
    await processLevel(null);
}

/**
 * 
 * @param {Iterable<RemotePage>} remotePages 
 */
async function unpublish(remotePages) {
    for (let page of remotePages) {
        await confluence.deletePage(page.id).then(() => {
            logger.debug(`Deleted Page: [${page.id}] ${page.title}`);
        });
    }
}

/**
 * Cleanup all pages from confluence
 * 
 * @returns {Promise<void>}
 */
async function cleanup() {
    const { siteName } = await context.getContext();
    try {
        const home = await confluence.findPage(siteName);
        if (!home) {
            logger.warn(`No page with title "${siteName}" found in confluence, nothing to clean here`);
            return;
        }
        const remotePages = await confluence.getChildPages(home.id);
        // Delete all children
        await unpublish(remotePages.values());
        // Delete home
        await unpublish([home]);
        cleanupSummary(siteName);
    } catch (error) {
        errorHandler(error);
    }
}

/**
 * Write action summary after cleanup
 * 
 * @param {string} siteName - The site name 
 */
function cleanupSummary(siteName) {
    logger.summary.addHeading(':broom: Cleanup', 1)
        .addRaw(`All confluence pages of "${siteName}" have been deleted`).addEOL()
        .write();
}

export { sync, cleanup };
