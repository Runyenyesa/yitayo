# Yitayo - E-Transit Infrastructure Tracker

Yitayo is a high-utility, open-source transit tracking system designed for the **Kayoola EVS (Electric Vehicle Series)** bus fleet in the Kampala Metropolitan Area [KMC]. 

The defining core constraint of this project is **Zero-Hardware tracking**. Traditional GPS tracking boxes are expensive, prone to vehicle circuit overloads, and vulnerable to theft or maintenance tampering. Yitayo moves the tracking workload entirely into software by utilizing a distributed **Citizen-Sensor Network** and static operational infrastructure handshakes.

---

##  How the Tracking System Functions

Yitayo divides its tracking lifecycle into two distinct execution paths to achieve continuous remote asset location logs without active onboard hardware trackers:

Use code with caution.[DAYTIME TRACKING]Commuter App Checks In ➔ Mobile GPS Aggregation ➔ Weighted Vector Filtering ➔ Real-Time Map Render[NIGHTTIME LOCKDOWN]Driver Logs Off Shift ➔ Depot QR Authentication ➔ KMC Charging Dock Network Handshake ➔ Status Lock
### 1. Daytime Operations: Crowdsourced Active Loop
Instead of tracking the *machine*, Yitayo tracks the *trip* using the devices inside the vehicle space.
* **The Scan Check-In:** High-durability vinyl sheets printed with location-unique, cryptographic QR codes are affixed across the interior walls of each Kayoola bus. 
* **The Token Anchor:** When a passenger or conductor launches the application and validates their ride via the QR code, the platform requests brief, low-power background location coordinate telemetry.
* **Deterministic Algorithmic Matching:** The backend ingests these individual passenger device coordinate streams. It applies a rolling time-window filter, drops erratic outliers (e.g., someone walking away from a window), and calculates a weighted velocity vector average. If 15 passenger devices move down Jinja Road simultaneously at 40 km/h, the server mathematically verifies the bus's precise real-time placement marker.

### 2. Nighttime Operations: Closed-Loop Geo-Locking
When the bus is empty and crowdsourcing goes completely dark, administrative workflows secure the asset state.
* **The Driver Check-Out:** Upon shift completion at the terminus, the operator must scan a permanent, geo-fenced **Depot Stall QR code** to safely exit their active driver work-session console.
* **The Smart Charger Handshake:** Because the Kayoola EVS is a fully electric utility vehicle running on a **560 kWh lithium-ion battery system** [KMC], it must dock at a terminal station charger overnight. Smart chargers communicate natively with our asset API during high-voltage links, supplying live battery health telemetry while locking the vehicle position coordinates firmly into a "Securely Parked" state on the admin dashboard.

---

##Repository Directory Layout & View States 📂 

Our current frontend wireframe collection relies on a zero-cost mapping layout powered by **Tailwind CSS** and **Leaflet.js** to handle interactive rendering without API token fee footprints:

* **`explore.html`** *(The Public Commuter Portal)*: Public landing layout featuring localized route searches, active transit corridors, and live route ETA calculations (with **`index.html`** acting as the entry point redirecting to `explore.html`).
* **`passenger.html`** *(The Mobile Scan Anchor Page)*: Triggered upon physical QR interaction inside the vehicle cabin; displays connection status confirmation and handles background telemetry initialization.
* **`driver.html`** *(The Operator Console Terminal)*: Dashboard interface containing real-time active route metrics, passenger anchor tracking counters, and the nighttime shift-close protocol modules.
* **`admin.html`** *(The MoWT Control Room Grid)*: Centralized Ministry dashboard executing dynamic map zooms and tracking node updates across Kampala Central coordinate bounds.
* **`qr-matrix.html`** *(The Back-Office Asset Ledger)*: Internal CRUD matrix tool to provision vehicle metrics and generate target cryptographic vinyl print templates.
* **`analytics.html`** *(The Operational Intelligence Dashboard)*: Telemetry panel monitoring fleet energy efficiency markers (kWh/km) and active depot charge-loop feedback.
* **`app.js`** *(The Prototype Controller)*: Core JavaScript engine managing route click mapping and prototype workflow state transitions.

---

##  Onboarding Instructions for New Contributors

### Local Execution & Testing Flow
To map and test the prototype navigation journey locally:
1. Clone this repository to your local development environment.
2. Ensure all files reside in a flat hierarchy within the same folder structure.
3. Open `index.html` inside any standard browser window.
4. Execute the verification loop: 
   - Tap the bottom banner on **`index.html`** to transition to **`passenger.html`**.
   - Select the route view switch link to map coordinates inside **`admin.html`**.
   - Launch **`driver.html`** in an alternate split window and process the depot scan trigger layout to step into **`analytics.html`**.

### Current Tasks & Backend Roadmap
Contributors joining the team should look over our open milestones panel to start moving the prototype into production software loops:
* [ ] **Database Schema Execution:** Provisioning a PostgreSQL instance mapping vehicles, routes, active trip sessions, and telemetry log data streams.
* [ ] **The Matching Algorithm Engine:** Engineering an ingestion microservice (Node.js or Python FastAPI) that processes coordinate bursts and filters anomalies via rolling averages.
* [ ] **Dynamic QR Fingerprinting:** Refactoring static QR routes to execute secure time-hashed keys, preventing fraudulent remote checking tricks.
