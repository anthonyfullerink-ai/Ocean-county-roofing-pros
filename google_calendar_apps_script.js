/**
 * Google Apps Script Webhook: Automatic Google Calendar Booking & Mobile App Notifications
 * 
 * Setup Instructions (Takes 60 seconds):
 * 1. Open https://script.google.com in your browser while signed in as anthony.fuller.ink@gmail.com
 * 2. Click "New Project" and paste this entire code block into Code.gs
 * 3. Click "Deploy" -> "New deployment"
 * 4. Select type: "Web app"
 *    - Description: "Ocean County Roofing Pros Calendar Webhook"
 *    - Execute as: "Me (anthony.fuller.ink@gmail.com)"
 *    - Who has access: "Anyone"
 * 5. Click "Deploy", authorize permissions, and copy the Web App URL (ends in /exec)
 * 6. Set GOOGLE_CALENDAR_WEBHOOK_URL in Netlify and .env to this URL.
 */

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    
    var calendarId = data.calendar_id || "7df414b869c61a9932cc261f1c9951bcbcd8c3c59e6ea057495e65db2720e02f@group.calendar.google.com";
    var calendar = CalendarApp.getCalendarById(calendarId);
    if (!calendar) {
      calendar = CalendarApp.getDefaultCalendar();
    }
    
    var summary = data.summary || ("Roof Inspection: " + (data.customer_name || "Homeowner"));
    var location = data.location || data.address || "Toms River, NJ";
    var startTime = new Date(data.start);
    var endTime = new Date(data.end || (startTime.getTime() + 60 * 60 * 1000));
    
    var description = [
      "Customer: " + (data.customer_name || "Homeowner"),
      "Phone: " + (data.phone || "Not provided"),
      "Email: " + (data.customer_email || "Not provided"),
      "Address: " + location,
      "Service: " + (data.service || "21-Point Drone Roof Inspection"),
      "",
      "--- LEAD QUALIFICATION DETAILS ---",
      "Homeowner: " + (data.is_homeowner || "Yes"),
      "Roof Age / Condition: " + (data.roof_age || "Standard inspection"),
      "Attic Access: " + (data.attic_access || "Yes"),
      "Ladder Needed: " + (data.ladder_needed || "Check on arrival"),
      "Decision Makers Present: " + (data.decision_makers_present || "Yes"),
      "",
      "Dispatched via Ocean County Roofing Pros Referral Network"
    ].join("\n");
    
    // Create the event with automatic email invitations sent
    var options = {
      description: description,
      location: location,
      sendInvites: true
    };
    
    if (data.customer_email && data.customer_email.indexOf("@") !== -1) {
      options.guests = data.customer_email.trim();
    }
    
    var event = calendar.createEvent(summary, startTime, endTime, options);
    
    // Add pop-up notifications for calendar app
    event.removeAllReminders();
    event.addPopupReminder(15);  // 15 min reminder
    event.addPopupReminder(60);  // 1 hour reminder
    event.addEmailReminder(1440); // 24 hours prior reminder
    
    return ContentService.createTextOutput(JSON.stringify({
      status: "success",
      eventId: event.getId(),
      calendarId: calendarId,
      summary: summary,
      start: startTime.toISOString(),
      end: endTime.toISOString()
    })).setMimeType(ContentService.MimeType.JSON);
    
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({
      status: "error",
      message: err.toString()
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

function doGet(e) {
  return ContentService.createTextOutput(JSON.stringify({
    status: "active",
    service: "Ocean County Roofing Pros Calendar Webhook"
  })).setMimeType(ContentService.MimeType.JSON);
}
