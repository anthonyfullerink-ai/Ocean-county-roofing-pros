/**
 * Ocean County Roofing Pros - High-Converting Capture-First + Live Google Calendar Booking Engine
 * Handles:
 *  - Step 1 & Step 2 diagnostic micro-commitments + emergency leak fast-track
 *  - Estimator carryover (#estimator -> Step 3 badge + Step 4 gated NJ Cost Guide)
 *  - Step 3 Capture-First lead save (POST /api/leads/webform) with honest error handling
 *  - Step 4 Live Google Calendar slot picker (GET /api/calendar/availability, POST /api/calendar/book)
 *  - In-card Quick Email Inquiry fallback + Call tracking
 */
(function () {
    const quizSection = document.getElementById('quizSection');
    if (!quizSection) return;

    const pageTown = quizSection.dataset.town || 'Toms River';
    const pagePhone = quizSection.dataset.phone || '(732) 660-9121';

    window.quizData = {
        situation: '',
        homeType: '',
        service: 'Full Roof Replacement',
        leadId: '',
        firstName: '',
        phone: '',
        email: '',
        address: '',
        smsConsent: false,
        city: pageTown,
        estimator: window.ocrpEstimatorSelection || null,
        availabilityDays: [],
        selectedDate: '',
        selectedDisplayDay: '',
        selectedTime: '',
        selectedStartIso: ''
    };

    function track(name, params) {
        if (typeof window.ocrpTrackEvent === 'function') {
            window.ocrpTrackEvent(name, params || {});
        }
    }

    function escapeText(v) {
        return String(v || '').replace(/[&<>"']/g, function (m) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
        });
    }

    function computeTailoredBallpark() {
        if (window.quizData.estimator && window.quizData.estimator.low) {
            const est = window.quizData.estimator;
            return {
                tag: `${est.tierLabel || 'Selected Spec'} • ${Number(est.sqft || 2000).toLocaleString()} sq ft`,
                range: `$${Number(est.low).toLocaleString()} – $${Number(est.high).toLocaleString()}`,
                sub: `Estimated from ~$${Number(est.monthlyLow || 144).toLocaleString()}/mo* • Written quote free on-site`
            };
        }

        if (window.quizData.situation === 'Active Water Leak') {
            return {
                tag: 'Targeted Leak & Flashing Diagnostics',
                range: '$450 – $1,850 (Typical Repair)',
                sub: 'Includes moisture scan & written fix-vs-replace breakdown'
            };
        }

        let low = 9200;
        let high = 12800;
        const arch = window.quizData.homeType || '';
        if (arch.includes('1-Story Ranch')) {
            low = 7800;
            high = 10900;
        } else if (arch.includes('2-Story Colonial')) {
            low = 10800;
            high = 14900;
        } else if (arch.includes('Coastal')) {
            low = 11400;
            high = 15800;
        } else if (arch.includes('Split-Level')) {
            low = 9600;
            high = 13600;
        }
        const monthly = Math.max(89, Math.round(low / 72));
        return {
            tag: `${arch || 'Ocean County Home'} • Coastal 160-MPH Spec Guide`,
            range: `$${low.toLocaleString()} – $${high.toLocaleString()}`,
            sub: `Flexible financing from ~$${monthly.toLocaleString()}/mo* • Exact price locked free on-site`
        };
    }

    function updateStep4BallparkUI() {
        const tagEl = document.getElementById('step4BallparkTag');
        const rangeEl = document.getElementById('step4BallparkRange');
        const subEl = document.getElementById('step4BallparkSub');
        if (!tagEl || !rangeEl || !subEl) return;

        const b = computeTailoredBallpark();
        tagEl.textContent = b.tag;
        rangeEl.textContent = b.range;
        subEl.textContent = b.sub;
    }

    function hideAllPanels() {
        ['quizStep1', 'quizStep2', 'quizStep3', 'quizStep4', 'emailInquiryMode', 'formSuccess'].forEach(function (id) {
            const el = document.getElementById(id);
            if (el) el.classList.add('hidden');
        });
    }

    window.goToQuizStep = function (step) {
        hideAllPanels();
        const progWrap = document.getElementById('quizProgressWrapper');
        const altWrap = document.getElementById('quizAltChannels');
        if (progWrap) progWrap.classList.remove('hidden');
        if (altWrap) altWrap.classList.remove('hidden');

        const stepEl = document.getElementById('quizStep' + step);
        if (stepEl) stepEl.classList.remove('hidden');

        const label = document.getElementById('quizStepLabel');
        const pct = document.getElementById('quizStepPct');
        const bar = document.getElementById('quizProgressBar');
        if (!label || !pct || !bar) return;

        if (step === 1) {
            label.innerText = 'Step 1 of 4: Problem Triage';
            pct.innerText = '25%';
            bar.style.width = '25%';
        } else if (step === 2) {
            label.innerText = 'Step 2 of 4: Property Calibrate';
            pct.innerText = '50%';
            bar.style.width = '50%';
        } else if (step === 3) {
            label.innerText = 'Step 3 of 4: Contact & Dispatch';
            pct.innerText = '75%';
            bar.style.width = '75%';
        } else if (step === 4) {
            label.innerText = 'Step 4 of 4: Pick Inspection Time';
            pct.innerText = '95%';
            bar.style.width = '95%';
        }
    };

    window.selectQuizStep1 = function (situation) {
        window.quizData.situation = situation;
        const sitInput = document.getElementById('quizSituation');
        if (sitInput) sitInput.value = situation;

        if (situation === 'Active Water Leak') {
            window.quizData.service = 'Emergency Leak Repair';
        } else if (situation === 'Storm & Wind Damage') {
            window.quizData.service = 'Storm / Wind Damage Inspection';
        } else {
            window.quizData.service = 'Complete Roof Replacement';
        }

        const serviceInput = document.getElementById('service');
        if (serviceInput) serviceInput.value = window.quizData.service;

        const leakBanner = document.getElementById('emergencyLeakBanner');
        if (leakBanner) {
            if (situation === 'Active Water Leak') {
                leakBanner.classList.remove('hidden');
                fetch(`/api/calendar/availability?city=${encodeURIComponent(pageTown)}&urgent=true&days=1`, { cache: 'no-store' })
                    .then(r => r.ok ? r.json() : null)
                    .then(d => {
                        if (d && d.emergency_dispatch) updateEmergencyBannerUI(d.emergency_dispatch);
                    })
                    .catch(() => {});
            } else {
                leakBanner.classList.add('hidden');
            }
        }

        track('quiz_step_complete', { step: 1, situation: situation });
        window.goToQuizStep(2);
    };

    window.selectQuizStep2 = function (homeType) {
        window.quizData.homeType = homeType;
        const homeInput = document.getElementById('quizHomeType');
        if (homeInput) homeInput.value = homeType;

        track('quiz_step_complete', { step: 2, home_type: homeType });
        window.goToQuizStep(3);
    };

    window.applyEstimatorSelectionToWidget = function (est) {
        window.quizData.estimator = est;
        const badge = document.getElementById('estimatorContextBadge');
        const txt = document.getElementById('estimatorContextText');
        if (badge && txt && est) {
            txt.textContent = `${est.tierLabel} • ${Number(est.sqft).toLocaleString()} sq ft • $${Number(est.low).toLocaleString()}–$${Number(est.high).toLocaleString()}`;
            badge.classList.remove('hidden');
        }
        if (!window.quizData.situation) {
            window.quizData.situation = 'Full Replacement & Architectural Upgrade';
            const sitInput = document.getElementById('quizSituation');
            if (sitInput) sitInput.value = window.quizData.situation;
        }
        if (!window.quizData.homeType) {
            window.quizData.homeType = 'Cost Guide Calibrated';
            const homeInput = document.getElementById('quizHomeType');
            if (homeInput) homeInput.value = window.quizData.homeType;
        }
        window.goToQuizStep(3);
    };

    window.clearEstimatorSelection = function () {
        window.quizData.estimator = null;
        window.ocrpEstimatorSelection = null;
        const badge = document.getElementById('estimatorContextBadge');
        if (badge) badge.classList.add('hidden');
    };

    window.toggleEmailMode = function (showEmail) {
        const progWrap = document.getElementById('quizProgressWrapper');
        const altWrap = document.getElementById('quizAltChannels');
        if (showEmail) {
            hideAllPanels();
            if (progWrap) progWrap.classList.add('hidden');
            if (altWrap) altWrap.classList.add('hidden');
            const emailPanel = document.getElementById('emailInquiryMode');
            if (emailPanel) emailPanel.classList.remove('hidden');
            track('email_inquiry_opened', { city: pageTown });
        } else {
            window.goToQuizStep(1);
        }
    };

    function renderCalendarSlotsForDate(isoDate) {
        const days = window.quizData.availabilityDays || [];
        const dayObj = days.find(function (d) { return d.date === isoDate; }) || days[0];
        if (!dayObj) return;

        window.quizData.selectedDate = dayObj.date;
        window.quizData.selectedDisplayDay = dayObj.display_label;
        window.quizData.selectedTime = '';
        window.quizData.selectedStartIso = '';

        const confirmBtn = document.getElementById('confirmSlotBtn');
        if (confirmBtn) confirmBtn.disabled = true;

        // Update active day pill styling
        document.querySelectorAll('.ocrp-day-pill').forEach(function (btn) {
            if (btn.dataset.date === dayObj.date) {
                btn.className = 'ocrp-day-pill min-h-[44px] p-2.5 rounded-xl border-2 border-brand-blue bg-sky-50 text-brand-navy text-center transition cursor-pointer shadow-sm';
            } else {
                btn.className = 'ocrp-day-pill min-h-[44px] p-2.5 rounded-xl border-2 border-slate-200 hover:border-slate-300 bg-white text-slate-700 text-center transition cursor-pointer';
            }
        });

        const slotsWrap = document.getElementById('calendarTimeSlots');
        if (!slotsWrap) return;
        slotsWrap.innerHTML = '';

        (dayObj.slots || []).forEach(function (slot) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'ocrp-slot-btn min-h-[46px] p-2.5 rounded-xl border-2 border-slate-200 hover:border-emerald-500 hover:bg-emerald-50/40 text-left transition flex items-center justify-between';
            btn.dataset.time = slot.time;
            btn.innerHTML = `<div><div class="font-black text-sm text-slate-900">${escapeText(slot.time)}</div><div class="text-[11px] text-slate-500">${escapeText(slot.tag || 'Arrival Window')}</div></div><span class="text-xs font-bold text-emerald-700">Open</span>`;

            btn.onclick = function () {
                window.quizData.selectedTime = slot.time;
                window.quizData.selectedStartIso = slot.start_iso || '';
                document.querySelectorAll('.ocrp-slot-btn').forEach(function (other) {
                    other.className = 'ocrp-slot-btn min-h-[46px] p-2.5 rounded-xl border-2 border-slate-200 hover:border-emerald-500 hover:bg-emerald-50/40 text-left transition flex items-center justify-between';
                });
                btn.className = 'ocrp-slot-btn min-h-[46px] p-2.5 rounded-xl border-2 border-emerald-600 bg-emerald-50 text-left transition flex items-center justify-between shadow-sm';
                if (confirmBtn) {
                    confirmBtn.disabled = false;
                    confirmBtn.innerHTML = `<span>✓ Confirm ${escapeText(dayObj.display_label)} at ${escapeText(slot.time)}</span>`;
                }
                track('calendar_slot_selected', { date: dayObj.date, time: slot.time, city: pageTown });
            };
            slotsWrap.appendChild(btn);
        });
    }

    function buildExternalBookingUrl(rawUrl) {
        try {
            const u = new URL(rawUrl);
            const lowerHost = u.hostname.toLowerCase();
            if (window.quizData.firstName && !u.searchParams.has('name')) {
                u.searchParams.set('name', window.quizData.firstName);
            }
            if (window.quizData.email && !u.searchParams.has('email')) {
                u.searchParams.set('email', window.quizData.email);
            }
            if (window.quizData.leadId) {
                u.searchParams.set('utm_content', window.quizData.leadId);
                if (lowerHost.includes('cal.com')) {
                    u.searchParams.set('metadata[lead_id]', window.quizData.leadId);
                }
            }
            if (lowerHost.includes('calendly.com')) {
                u.searchParams.set('embed_domain', window.location.hostname || 'oceancountyroofingpros.com');
                u.searchParams.set('embed_type', 'Inline');
                u.searchParams.set('hide_gdpr_banner', '1');
            } else if (lowerHost.includes('hubspot.com') && !u.searchParams.has('embed')) {
                u.searchParams.set('embed', 'true');
            }
            return {
                url: u.toString(),
                embedSupported: (
                    lowerHost.includes('calendly.com') ||
                    lowerHost.includes('hubspot.com') ||
                    lowerHost.includes('cal.com') ||
                    lowerHost.includes('acuityscheduling.com')
                )
            };
        } catch {
            return { url: rawUrl, embedSupported: false };
        }
    }

    // Listen for inline embed booking completion events (Calendly, Cal.com, HubSpot Meetings)
    window.addEventListener('message', function (e) {
        if (!e || !e.data) return;
        const d = e.data;
        let provider = '';
        let startTime = '';

        if (d.event === 'calendly.event_scheduled') {
            provider = 'calendly';
            startTime = d.payload?.event?.start_time || '';
        } else if (d.type === 'CAL:bookingSuccessful' || d.type === '__cal_booking_successful') {
            provider = 'cal.com';
            startTime = d.data?.date || d.data?.startTime || '';
        } else if (d.meetingBookSucceeded) {
            provider = 'hubspot';
            startTime = d.meetingsPayload?.bookingResponse?.event?.dateString || '';
        }

        if (!provider || !window.quizData.leadId) return;

        fetch('/api/calendar/webhook', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                provider: provider,
                lead_id: window.quizData.leadId,
                name: window.quizData.firstName,
                email: window.quizData.email,
                start_time: startTime
            })
        }).catch(function () {});

        track('booking_confirmed', {
            lead_id: window.quizData.leadId,
            provider: provider,
            city: pageTown
        });

        showFinalSuccess({
            title: 'Inspection Locked In!',
            subtitle: `Your appointment with our ${pageTown} partner has been scheduled and synced.`,
            slotBannerText: startTime ? `🗓️ Confirmed (${provider})` : `✓ Booked via Partner Calendar`,
            gcalAddUrl: ''
        });
    });

    function updateEmergencyBannerUI(emerg) {
        const leakBanner = document.getElementById('emergencyLeakBanner');
        const titleEl = document.getElementById('emergencyBannerTitle');
        const bodyEl = document.getElementById('emergencyBannerBody');
        const feeEl = document.getElementById('emergencyFeeNoteText');
        if (!leakBanner || !emerg) return;

        window.quizData.emergencyDispatch = emerg;
        if (window.quizData.situation === 'Active Water Leak') {
            leakBanner.classList.remove('hidden');
        }

        const company = emerg.dispatch_company || 'Our local partner';
        if (titleEl && bodyEl) {
            if (emerg.available_now) {
                titleEl.textContent = emerg.is_overflow
                    ? '🚨 24/7 Emergency Overflow Crew On Standby'
                    : (emerg.mode === 'live_transfer' ? '🚨 24/7 Emergency Dispatch Ready' : '🚨 Priority Emergency Callback Active');
                bodyEl.textContent = emerg.mode === 'live_transfer'
                    ? `${company} has an active on-call leak crew right now — call now or submit for immediate priority dispatch.`
                    : `${company} receives an instant urgent SMS dispatch alert when you submit — priority callback & tarping triage.`;
            } else {
                titleEl.textContent = 'Priority Next-Morning Roof Leak Triage (9:00 AM)';
                bodyEl.textContent = emerg.after_hours_quiet
                    ? `${company} emergency crews are in quiet hours right now. Submit below for instant priority SMS queuing & our first 9:00 AM morning inspection slot.`
                    : `Live overnight emergency dispatch is offline for ${pageTown}. Submit or select the earliest 9:00 AM priority slot below for first-morning callback.`;
            }
        }
        if (feeEl) {
            if (emerg.tarping_fee_note) {
                feeEl.textContent = emerg.tarping_fee_note;
                feeEl.classList.remove('hidden');
            } else {
                feeEl.classList.add('hidden');
            }
        }
    }

    async function loadCalendarStep(step3Response) {
        window.goToQuizStep(4);
        updateStep4BallparkUI();
        if (step3Response && step3Response.emergency_dispatch) {
            updateEmergencyBannerUI(step3Response.emergency_dispatch);
        }

        const leadBadge = document.getElementById('step4LeadIdBadge');
        if (leadBadge && window.quizData.leadId) {
            leadBadge.textContent = '#' + window.quizData.leadId;
        }

        const extWrap = document.getElementById('externalBookingContainer');
        const extLink = document.getElementById('externalBookingLink');
        const extEmbedWrap = document.getElementById('externalEmbedWrapper');
        const extIframe = document.getElementById('externalBookingIframe');
        const pickerWrap = document.getElementById('calendarPickerContainer');

        if (step3Response && step3Response.scheduling_type === 'external_link' && step3Response.booking_url) {
            if (pickerWrap) pickerWrap.classList.add('hidden');
            if (extWrap && extLink) {
                const built = buildExternalBookingUrl(step3Response.booking_url);
                extLink.href = built.url;
                extLink.onclick = function () {
                    track('schedule_booking_click', { booking_url: built.url });
                };
                if (extEmbedWrap && extIframe && built.embedSupported) {
                    extIframe.src = built.url;
                    extEmbedWrap.classList.remove('hidden');
                } else if (extEmbedWrap) {
                    extEmbedWrap.classList.add('hidden');
                }
                extWrap.classList.remove('hidden');
            }
            return;
        }

        if (extWrap) extWrap.classList.add('hidden');
        if (extEmbedWrap) extEmbedWrap.classList.add('hidden');
        if (pickerWrap) pickerWrap.classList.remove('hidden');

        const loadingEl = document.getElementById('calendarLoading');
        const contentEl = document.getElementById('calendarContent');
        if (loadingEl) loadingEl.classList.remove('hidden');
        if (contentEl) contentEl.classList.add('hidden');

        try {
            const isUrgent = window.quizData.situation === 'Active Water Leak';
            const res = await fetch(
                `/api/calendar/availability?city=${encodeURIComponent(pageTown)}&urgent=${isUrgent ? 'true' : 'false'}&days=6`,
                { cache: 'no-store' }
            );
            const data = res.ok ? await res.json() : null;
            if (data && data.emergency_dispatch) {
                updateEmergencyBannerUI(data.emergency_dispatch);
            }
            const days = (data && Array.isArray(data.days)) ? data.days : [];
            window.quizData.availabilityDays = days;

            if (days.length === 0) {
                if (loadingEl) {
                    loadingEl.innerHTML = `Calendar is filling fast — call <a href="tel:${escapeText(pagePhone)}" class="underline font-black text-brand-blue">${escapeText(pagePhone)}</a> or click Skip below for priority dispatch.`;
                }
                return;
            }

            const pillsWrap = document.getElementById('calendarDatePills');
            if (pillsWrap) {
                pillsWrap.innerHTML = '';
                days.slice(0, 6).forEach(function (dayObj) {
                    const pill = document.createElement('button');
                    pill.type = 'button';
                    pill.dataset.date = dayObj.date;
                    pill.className = 'ocrp-day-pill p-2.5 rounded-xl border-2 border-slate-200 bg-white text-slate-700 text-center transition';
                    pill.innerHTML = `<div class="text-[10px] font-black uppercase tracking-wider text-teal-700">${escapeText(dayObj.relative_label)}</div><div class="text-xs font-extrabold text-slate-900 mt-0.5">${escapeText(dayObj.display_label)}</div>`;
                    pill.onclick = function () { renderCalendarSlotsForDate(dayObj.date); };
                    pillsWrap.appendChild(pill);
                });
            }

            if (loadingEl) loadingEl.classList.add('hidden');
            if (contentEl) contentEl.classList.remove('hidden');
            renderCalendarSlotsForDate(days[0].date);
        } catch (err) {
            console.error('Error loading calendar slots:', err);
            if (loadingEl) {
                loadingEl.textContent = 'Live slots temporarily unavailable — click Skip below and our estimator will confirm by text within minutes.';
            }
        }
    }

    function showFinalSuccess({ title, subtitle, slotBannerText, gcalAddUrl }) {
        hideAllPanels();
        const progWrap = document.getElementById('quizProgressWrapper');
        const altWrap = document.getElementById('quizAltChannels');
        if (progWrap) progWrap.classList.add('hidden');
        if (altWrap) altWrap.classList.add('hidden');

        const titleEl = document.getElementById('successTitle');
        const subEl = document.getElementById('successSubtitle');
        const refEl = document.getElementById('successLeadRef');
        const bannerEl = document.getElementById('confirmedSlotBanner');
        const gcalWrap = document.getElementById('addToGcalContainer');
        const gcalLink = document.getElementById('addToGcalLink');

        if (titleEl) titleEl.textContent = title;
        if (subEl) subEl.textContent = subtitle;
        if (refEl) refEl.textContent = window.quizData.leadId || 'Confirmed';

        if (bannerEl) {
            if (slotBannerText) {
                bannerEl.textContent = slotBannerText;
                bannerEl.classList.remove('hidden');
            } else {
                bannerEl.classList.add('hidden');
            }
        }

        if (gcalWrap && gcalLink) {
            if (gcalAddUrl) {
                gcalLink.href = gcalAddUrl;
                gcalWrap.classList.remove('hidden');
            } else {
                gcalWrap.classList.add('hidden');
            }
        }

        const successEl = document.getElementById('formSuccess');
        if (successEl) successEl.classList.remove('hidden');
    }

    window.confirmCalendarBooking = async function () {
        if (!window.quizData.selectedDate || !window.quizData.selectedTime) return;
        const btn = document.getElementById('confirmSlotBtn');
        const errBox = document.getElementById('calendarBookError');
        if (errBox) errBox.classList.add('hidden');
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<span>Locking In Your Calendar Slot...</span>';
        }

        try {
            const res = await fetch('/api/calendar/book', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    lead_id: window.quizData.leadId,
                    date: window.quizData.selectedDate,
                    display_day: window.quizData.selectedDisplayDay,
                    time: window.quizData.selectedTime,
                    name: window.quizData.firstName,
                    phone: window.quizData.phone,
                    email: window.quizData.email,
                    address: window.quizData.address,
                    city: pageTown,
                    service: window.quizData.service,
                    diagnostic_situation: window.quizData.situation,
                    home_architecture: window.quizData.homeType,
                    consent_given: Boolean(window.quizData.smsConsent)
                })
            });

            if (res.status === 409) {
                const errData = await res.json();
                if (errBox) {
                    errBox.textContent = errData.message || 'That slot was just booked. Please pick another window.';
                    errBox.classList.remove('hidden');
                }
                await loadCalendarStep({});
                return;
            }

            if (!res.ok) {
                throw new Error('Could not confirm slot');
            }

            const data = await res.json();
            track('booking_confirmed', {
                lead_id: window.quizData.leadId,
                slot: data.appointment_slot,
                city: pageTown
            });

            let gcalQuickUrl = '';
            if (data.start_iso && data.end_iso) {
                const toCompact = function (iso) {
                    return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
                };
                const datesParam = `${toCompact(data.start_iso)}/${toCompact(data.end_iso)}`;
                gcalQuickUrl = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent('21-Point Roof Inspection - Ocean County Roofing Pros')}&dates=${encodeURIComponent(datesParam)}&location=${encodeURIComponent(window.quizData.address || pageTown + ', NJ')}`;
            }

            showFinalSuccess({
                title: 'Inspection Locked In!',
                subtitle: `Our estimator for ${pageTown} is booked and confirmed.`,
                slotBannerText: `🗓️ ${window.quizData.selectedDisplayDay} at ${window.quizData.selectedTime}`,
                gcalAddUrl: gcalQuickUrl
            });
        } catch (err) {
            console.error(err);
            if (errBox) {
                errBox.textContent = `We had trouble confirming that window. Please tap another time or call ${pagePhone}.`;
                errBox.classList.remove('hidden');
            }
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = '<span>✓ Confirm Selected Date &amp; Time</span>';
            }
        }
    };

    window.skipCalendarStep = function () {
        showFinalSuccess({
            title: '21-Point Inspection Request Received!',
            subtitle: window.quizData.smsConsent
                ? `Our on-call estimator for ${pageTown} has your file and will text/call shortly to confirm an exact arrival window.`
                : `Our on-call estimator for ${pageTown} has your file and will call or email shortly to confirm an exact arrival window.`,
            slotBannerText: '',
            gcalAddUrl: ''
        });
    };

    // Step 3 Contact Form Submission (Capture-First)
    const leadForm = document.getElementById('leadForm');
    if (leadForm) {
        leadForm.addEventListener('submit', async function (e) {
            e.preventDefault();
            const submitBtn = document.getElementById('submitBtn');
            const errBox = document.getElementById('quizErrorAlert');
            if (errBox) errBox.classList.add('hidden');

            const firstName = (document.getElementById('first_name')?.value || '').trim();
            const phone = (document.getElementById('phone')?.value || '').trim();
            const address = (document.getElementById('address')?.value || '').trim();
            const email = (document.getElementById('email')?.value || '').trim();
            const smsConsent = Boolean(document.getElementById('sms_consent')?.checked);

            const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
            if (!phone || !firstName || !address || !emailValid) {
                if (errBox) {
                    errBox.textContent = 'Please complete your name, phone number, property address, and a valid email address.';
                    errBox.classList.remove('hidden');
                }
                return;
            }

            window.quizData.firstName = firstName;
            window.quizData.phone = phone;
            window.quizData.address = address;
            window.quizData.email = email;
            window.quizData.smsConsent = smsConsent;

            if (submitBtn) {
                submitBtn.disabled = true;
                submitBtn.innerHTML = '<span>Saving &amp; Checking Live Calendar...</span>';
            }

            let notes = `[Diagnostic Quiz] Situation: ${window.quizData.situation || 'Not specified'} | Architecture: ${window.quizData.homeType || 'Not specified'}`;
            if (window.quizData.estimator) {
                const est = window.quizData.estimator;
                notes += ` | Cost Guide: ${est.tierLabel} (${est.sqft} sq ft, $${est.low}-$${est.high})`;
            }

            const payload = {
                service: window.quizData.service || document.getElementById('service')?.value || 'Full Roof Replacement',
                phone: phone,
                first_name: firstName,
                email: email,
                address: address,
                city: pageTown,
                contact_preference: 'calendar_flow',
                diagnostic_situation: window.quizData.situation || '',
                home_architecture: window.quizData.homeType || '',
                notes: notes,
                consent_given: smsConsent,
                sms_consent: smsConsent
            };

            try {
                const response = await fetch('/api/leads/webform', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });

                if (!response.ok) {
                    const errJson = await response.json().catch(function () { return {}; });
                    throw new Error(errJson.detail || errJson.error || 'Submission error');
                }

                const data = await response.json();
                window.quizData.leadId = data.lead_id || '';
                track('generate_lead', { service: payload.service, city: payload.city });

                await loadCalendarStep(data);
            } catch (err) {
                console.error(err);
                if (errBox) {
                    errBox.textContent = `Could not connect right now (${err.message}). Please try again or call ${pagePhone}.`;
                    errBox.classList.remove('hidden');
                }
            } finally {
                if (submitBtn) {
                    submitBtn.disabled = false;
                    submitBtn.innerHTML = '<span>📅 Continue to Live Calendar Times</span><svg class="w-5 h-5 fill-current" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M10.293 3.293a1 1 0 011.414 0l6 6a1 1 0 010 1.414l-6 6a1 1 0 01-1.414-1.414L14.586 11H3a1 1 0 110-2h11.586l-4.293-4.293a1 1 0 010-1.414z" clip-rule="evenodd"></path></svg>';
                }
            }
        });
    }

    // In-Card Email Inquiry Submission
    const emailForm = document.getElementById('emailInquiryForm');
    if (emailForm) {
        emailForm.addEventListener('submit', async function (e) {
            e.preventDefault();
            const submitBtn = document.getElementById('emailModeSubmitBtn');
            const errBox = document.getElementById('emailModeError');
            if (errBox) errBox.classList.add('hidden');

            const name = (document.getElementById('emailModeName')?.value || '').trim();
            const email = (document.getElementById('emailModeEmail')?.value || '').trim();
            const address = (document.getElementById('emailModeAddress')?.value || '').trim();
            const message = (document.getElementById('emailModeMessage')?.value || '').trim();

            if (!name || !email.includes('@') || !message) {
                if (errBox) {
                    errBox.textContent = 'Please provide your name, a valid email address, and your message.';
                    errBox.classList.remove('hidden');
                }
                return;
            }

            if (submitBtn) {
                submitBtn.disabled = true;
                submitBtn.textContent = 'Sending Email...';
            }

            try {
                const res = await fetch('/api/leads/webform', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        first_name: name,
                        email: email,
                        phone: '',
                        address: address,
                        city: pageTown,
                        service: 'Email Estimate & Inspection Inquiry',
                        contact_preference: 'email',
                        notes: `[Direct Email Inquiry] ${message}`,
                        consent_given: false
                    })
                });
                if (!res.ok) throw new Error('Email dispatch failed');
                const data = await res.json();
                window.quizData.leadId = data.lead_id || '';
                track('email_inquiry_sent', { city: pageTown });

                showFinalSuccess({
                    title: 'Email Sent to Our Dispatch Desk!',
                    subtitle: `Thank you, ${name}. Riley Davis received your message and sent a confirmation to ${email}.`,
                    slotBannerText: `✉️ Reply coming to ${email}`,
                    gcalAddUrl: ''
                });
            } catch (err) {
                console.error(err);
                if (errBox) {
                    errBox.textContent = `Could not send right now. Please email riley@oceancountyroofingpros.com or call ${pagePhone}.`;
                    errBox.classList.remove('hidden');
                }
            } finally {
                if (submitBtn) {
                    submitBtn.disabled = false;
                    submitBtn.textContent = '✉️ Send Email to Scheduling Desk';
                }
            }
        });
    }
})();
