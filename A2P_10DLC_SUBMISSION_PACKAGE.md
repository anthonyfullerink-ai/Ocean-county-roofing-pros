# Twilio A2P 10DLC Turnkey Submission Package
**Brand Asset:** Ocean County Roofing Pros (`oceancountyroofingpros.com`)  
**Parent Operating Entity:** Your Marketing / Lead Generation LLC (e.g. Sioux Design & Media LLC)  
**Use Case:** Customer Care & Appointment Scheduling

---

## 1. Brand Registration Details (Twilio Console Step 1)

When registering your Brand in the Twilio Console under **Messaging > Regulatory Compliance > Brands**:
* **Brand Type:** Standard Brand (or Low-Volume Standard if sending <6,000 msgs/day).
* **Legal Business Name:** Enter the exact legal name of your registered LLC / Sole Proprietorship (the parent agency that owns the digital asset). *Do not enter an unlicensed roofing entity name.*
* **Business Type:** LLC / Corporation / Sole Proprietorship.
* **EIN / Tax ID:** Enter the official 9-digit Federal Tax ID corresponding to your legal business name.
* **Address:** The official registered business address of your LLC.
* **Website:** `https://oceancountyroofingpros.com`

---

## 2. Campaign Registration Form (Twilio Console Step 2)

When creating your Messaging Campaign under **Messaging > Regulatory Compliance > Campaigns**:

### A. Campaign Details:
* **Campaign Use Case:** `Customer Care` (or `Mixed / Marketing`).
* **Campaign Description (Copy & Paste):**
  > *"Ocean County Roofing Pros coordinates residential roof inspection appointments, estimate scheduling confirmations, and automated service reminders for Ocean County, New Jersey homeowners who request a free on-site roof inspection on our website."*

---

### B. Message Flow & User Opt-in Description (Copy & Paste):
* **How do end-users consent to receive messages? (Copy & Paste):**
  > *"End-users opt in by visiting our website (https://oceancountyroofingpros.com) and submitting a free inspection request form. Directly above the submit button, users are presented with clear, un-checked consent language stating: 'By submitting, you authorize Ocean County Roofing Pros to match you with a vetted, licensed, and insured New Jersey roofing contractor for your free inspection, and agree to receive appointment reminders and project updates via call or text at the number provided. Consent is not a condition of purchase. Msg & data rates may apply. Reply STOP to cancel.' A link to our Privacy Policy (https://oceancountyroofingpros.com/privacy-policy) and Terms of Service (https://oceancountyroofingpros.com/terms) is visibly displayed with the form."*

* **Opt-in Keywords:** None (Webform opt-in).
* **Opt-in URL Proof:** `https://oceancountyroofingpros.com/#leadForm`

---

### C. Sample Messages (Copy & Paste):

#### Sample Message 1 (Immediate Booking Confirmation):
> *"Hi [Customer Name], thanks for contacting Ocean County Roofing Pros! We received your request for a Free 21-Point Roof Inspection in [City]. Our local estimator will arrive at the scheduled time. Reply STOP to opt out, HELP for help. Msg & data rates may apply."*

#### Sample Message 2 (Day-Before Appointment Reminder):
> *"Ocean County Roofing Pros reminder: Your free roof inspection is confirmed for tomorrow between 1:00 PM and 3:00 PM. Reply STOP to cancel or call 732-660-9121 for assistance."*

---

## 3. Mandatory Compliance Clauses Already Live on Your Site

Carriers (AT&T, T-Mobile, Verizon) automatically audit the provided URLs. The following mandatory clauses are already integrated into your live code:

1. **Carrier Privacy Disclosure ([`/privacy-policy`](file:///C:/Users/AnthonyFuller/.gemini/antigravity/scratch/ocean-county-roofing-pros/app/templates/privacy-policy.html)):**
   > *"No mobile information will be shared with third parties or affiliates for marketing or promotional purposes. All the above categories exclude text messaging originator opt-in data and consent; this information will not be shared with any third parties."*
2. **Opt-Out Instructions:**
   > *"If at any time you wish to stop receiving text messages from us, simply reply STOP to any text message."*
3. **Form Disclosure Check:**
   - Both `index.html` and `location_page.html` contain the exact opt-in disclosure, STOP notice, and direct links to Privacy Policy and Terms.
