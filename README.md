# Yitayo (यीतायो) - Crowdsourced E-Transit Grid for Kampala

**Yitayo** is a high-efficiency, zero-hardware remote vehicle tracking system engineered specifically for the **Kayoola EVS Electric Bus Fleet** operating within the Kampala Metropolitan Area. 

Developed as a technical proposal for the **Ministry of Works and Transport (MoWT) of Uganda**, Yitayo completely eliminates physical GPS tracking hardware boxes. This removes risks of electrical short-circuits, vandalism, maintenance overheads, and high component replacement costs.

---

## 🚀 The Core Breakthrough Architecture

Yitayo operates on a **Citizen-Sensor Network** layout model, dividing tracking into two secure operation loops:

1. **Daytime (Crowdsourced Active Loop):** When a passenger boards a Kayoola bus, they scan a secure, dynamic QR vinyl sticker layout on the vehicle frame. The platform matches passenger mobile background location tokens using **Deterministic Algorithmic Matching**. If multiple passengers follow the exact same velocity and path vector, the system validates the bus's live coordinate tracking space on the map without any hardware on the machine.
2. **Nighttime (Closed-Loop Geo-Locking):** At the end of a shift, drivers scan a fixed Stall Depot QR code. The system cross-references this with the physical digital signature handshake from the smart **Kiira Motors Corporation (KMC) charging dock infrastructure**, locking the vehicle asset status on the administrative grid.

---

## 📂 Project Directory Structure

```text
yitayo/
├── explore.html        # Public Commuter Portal & Route ETA Monitor
├── passenger.html      # Mobile Scan Check-in & Location Anchor Portal
├── driver.html         # Driver Console Terminal & Night Lock Trigger
├── admin.html          # Central MoWT Management Control Map Dashboard
├── qr-matrix.html      # Asset Ledger & Cryptographic Vinyl Print Generator
├── analytics.html      # EV Battery Telemetry & Energy Grid Monitor Logs
└── app.js              # Unified Prototype Interactivity & Routing Engine
```

---

## 🛠️ Interactive Prototype Interface Guide

The frontend prototype relies on a zero-cost open-source mapping architecture layout built with **Tailwind CSS** and **Leaflet.js** to show proof-of-concept without API fee footprints.

To run or review the platform journey flow locally:
1. Clone this repository or open the folder spaces.
2. Launch `explore.html` inside any web browser.
3. Simulate a commuter step-through flow:
   - On **`explore.html`**, tap the bottom banner *("Tap to Scan Dashboard QR Code & Check In")*.
   - On **`passenger.html`**, view the live tracking anchor activation page, then click *("View Live Route Map")*.
   - Analyze the main **`admin.html`** screen tracking live active simulated nodes over Kampala Central coordinates.
   - Access **`driver.html`** to execute the end-of-shift protocol simulation, which automatically maps into the deep **`analytics.html`** platform layout frame.

---

## ⚖️ National Impact & Security Framework

* **Zero Capital Expenditure (CapEx):** Zero procurement overhead for hardware tracking assets across the state-owned Kayoora transport enterprise layout.
* **100% Tamperproof Infrastructure:** Waterproof, high-durability vinyl print surfaces cannot be unclipped, bypassed, or stolen during routine mechanical maintenance checks.
* **Data Sovereignty Protection:** All processing, coordination streams, and fleet state datasets are compiled natively, aligning securely with local Ugandan server hosting policies.
