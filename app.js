/**
 * YITAYO - Unified Prototype Router
 * This file connects all front-end wireframes to create an interactive demo flow.
 */

document.addEventListener("DOMContentLoaded", () => {
    console.log("🚀 Yitayo Navigation Routing Engine initialized.");

    // 1. Identify which page the user is currently looking at based on the filename
    const currentPath = window.location.pathname;
    const currentPage = currentPath.substring(currentPath.lastIndexOf('/') + 1);

    // 2. Global Route Registry linking UI text patterns to target layout files
    const routes = {
        // Admin Navigation Links
        "Preview Layout": "qr-matrix.html",
        "Selected": "qr-matrix.html",
        
        // Passenger Interactions
        "View Live Route Map": "admin.html",
        "Tap to Scan Dashboard QR Code & Check In": "passenger.html",
        "⚡ Tap to Scan Dashboard QR Code & Check In": "passenger.html",
        
        // Driver Configurations
        "SCAN STATION DEPOT QR CODE": "analytics.html",
        
        // Back-Office Asset Management
        "View Analytics": "analytics.html",
        "Return to Dashboard": "admin.html"
    };

    // 3. Scan the active wireframe page for any clickable buttons or actionable elements
    const interactiveElements = document.querySelectorAll("button, [onclick], .cursor-pointer");

    interactiveElements.forEach(element => {
        // Clean up the text inside the button to match our route registry keywords
        const buttonText = element.textContent ? element.textContent.trim() : "";

        // If the button text matches one of our defined paths, assign the routing event
        if (routes[buttonText]) {
            // Remove any old native inline click properties to prevent layout code bugs
            if (element.hasAttribute("onclick") && !element.getAttribute("onclick").includes("focusBus")) {
                element.removeAttribute("onclick");
            }

            element.addEventListener("click", (e) => {
                e.preventDefault();
                console.log(`🔀 Routing from ${currentPage || 'index.html'} to: ${routes[buttonText]}`);
                window.location.href = routes[buttonText];
            });
        }
    });

    // 4. Page-Specific Hardcoded Overrides for Advanced Layout Elements
    setupSpecialPageTriggers(currentPage);
});

/**
 * Handles complex layout flows like list clicks or structural link ribbons
 */
function setupSpecialPageTriggers(pageName) {
    // If we are on the public explorer landing page
    if (pageName === "index.html" || pageName === "explore.html" || pageName === "") {
        // Look for the Active Corridor cards
        const routeCards = document.querySelectorAll(".card-hover, .bg-slate-900.rounded-2xl");
        routeCards.forEach(card => {
            card.style.cursor = "pointer";
            card.addEventListener("click", () => {
                // Clicking an active route takes the Ministry official to the Main Admin Map Grid
                window.location.href = "admin.html";
            });
        });
    }

    // Add a subtle Home navigation shortcut to the app logo banner on all pages
    const logoBranding = document.querySelector("#app-logo");
    if (logoBranding) {
        logoBranding.style.cursor = "pointer";
        logoBranding.addEventListener("click", () => {
            window.location.href = "admin.html";
        });
    }
}
