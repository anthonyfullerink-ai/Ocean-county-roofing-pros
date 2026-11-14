/**
 * Google Apps Script Webhook: Live Availability Check & Automatic Google Calendar Booking
 *
 * Setup Instructions:
 * 1. Open https://script.google.com while signed in as the dispatch Google account
 * 2. Paste this entire code block into Code.gs and click Save
 * 3. Click "Deploy" -> "Manage deployments" -> Edit (or "New deployment")
 *    - Type: "Web app"
 *    - Execute as: "Me"
 *    - Who has access: "Anyone"
 * 4. Copy the Web App URL (ends in /exec) into GOOGLE_CALENDAR_WEBHOOK_URL in Netlify & .env
 */

var DEFAULT_CALENDAR_ID = "7df414b869c61a9932cc261f1c9951bcbcd8c3c59e6ea057495e65db2720e02f@group.calendar.google.com";

function resolveCalendar_(calendarId) {
  var targetId = calendarId || DEFAULT_CALENDAR_ID;
  var calendar = CalendarApp.getCalendarById(targetId);
  if (!calendar) {
    calendar = CalendarApp.getDefaultCalendar();
  }
  return { calendar: calendar, calendarId: targetId };
}

function getBusyIntervals_(calendar, startDate, endDate) {
  var events = calendar.getEvents(startDate, endDate);
  var busy = [];
  for (var i = 0; i < events.length; i++) {
    var ev = events[i];
    if (ev.isAllDayEvent()) {
      busy.push({
        start: ev.getAllDayStartDate().toISOString(),
        end: ev.getAllDayEndDate().toISOString(),
        allDay: true
      });
    } else {
      busy.push({
        start: ev.getStartTime().toISOString(),
        end: ev.getEndTime().toISOString(),
        allDay: false
      });
    }
  }
  return busy;
}

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents || "{}");
    var resolved = resolveCalendar_(data.calendar_id);
    var calendar = resolved.calendar;
    var calendarId = resolved.calendarId;

    var startTime = new Date(data.start);
    if (isNaN(startTime.getTime())) {
      return ContentService.createTextOutput(JSON.stringify({
        status: "error",
        message: "Invalid start timestamp: " + data.start
      })).setMimeType(ContentService.MimeType.JSON);
    }
    var endTime = data.end ? new Date(data.end) : new Date(startTime.getTime() + 60 * 60 * 1000);

    // Optional real-time conflict check before creating the event
    if (data.check_conflict) {
      var overlapping = getBusyIntervals_(calendar, startTime, endTime);
      for (var i = 0; i < overlapping.length; i++) {
        var bStart = new Date(overlapping[i].start);
        var bEnd = new Date(overlapping[i].end);
        if (bStart.getTime() < endTime.getTime() && bEnd.getTime() > startTime.getTime()) {
          return ContentService.createTextOutput(JSON.stringify({
            status: "conflict",
            message: "Selected window is no longer available.",
            calendarId: calendarId,
            start: startTime.toISOString(),
            end: endTime.toISOString()
          })).setMimeType(ContentService.MimeType.JSON);
        }
      }
    }

    var summary = data.summary || ("Roof Inspection: " + (data.customer_name || "Homeowner"));
    var location = data.location || data.address || "Toms River, NJ";

    var description = [
      "Customer: " + (data.customer_name || "Homeowner"),
      "Phone: " + (data.phone || "Not provided"),
      "Email: " + (data.customer_email || "Not provided"),
      "Address: " + location,
      "Service: " + (data.service || "21-Point Roof & Attic Inspection"),
      "Lead ID: " + (data.lead_id || "Web"),
      "",
      "--- LEAD DIAGNOSTIC DETAILS ---",
      "Situation: " + (data.diagnostic_situation || data.roof_age || "Standard inspection"),
      "Home Type: " + (data.home_architecture || "Standard Residential"),
      "Homeowner: " + (data.is_homeowner || "Yes"),
      "Attic Access: " + (data.attic_access || "Yes"),
      "Notes: " + (data.notes || "Booked online via Ocean County Roofing Pros"),
      "",
      "Dispatched via Ocean County Roofing Pros Referral Network"
    ].join("\n");

    var options = {
      description: description,
      location: location,
      sendInvites: true
    };

    if (data.customer_email && data.customer_email.indexOf("@") !== -1) {
      options.guests = data.customer_email.trim();
    }

    var event = calendar.createEvent(summary, startTime, endTime, options);

    event.removeAllReminders();
    event.addPopupReminder(15);
    event.addPopupReminder(60);
    event.addEmailReminder(1440);

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
  try {
    var params = (e && e.parameter) ? e.parameter : {};
    if (params.action === "availability") {
      var resolved = resolveCalendar_(params.calendar_id);
      var startDate = params.start ? new Date(params.start) : new Date();
      var days = Math.min(Math.max(parseInt(params.days || "8", 10) || 8, 1), 14);
      var endDate = params.end
        ? new Date(params.end)
        : new Date(startDate.getTime() + days * 24 * 60 * 60 * 1000);

      var busy = getBusyIntervals_(resolved.calendar, startDate, endDate);
      return ContentService.createTextOutput(JSON.stringify({
        status: "success",
        action: "availability",
        calendarId: resolved.calendarId,
        busy: busy
      })).setMimeType(ContentService.MimeType.JSON);
    }

    return ContentService.createTextOutput(JSON.stringify({
      status: "active",
      service: "Ocean County Roofing Pros Calendar Webhook",
      supports_availability: true
    })).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({
      status: "error",
      message: err.toString()
    })).setMimeType(ContentService.MimeType.JSON);
  }
}
