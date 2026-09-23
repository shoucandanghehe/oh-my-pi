--!strict

local pending: {[number]: number} = {}
local workspace_tabs: {[number]: number} = {}
local timer: TimerHandle? = nil

local function workspace_pane(cx: WindowCx, pane: PaneInfo): boolean
	-- Tern 0.9.4's numeric pane lookups cannot resolve the ids it returns.
	local resolved = cx.session:pane(pane.title)
	if resolved == nil or resolved.pane ~= pane.pane or resolved.tab ~= pane.tab then
		return false
	end
	local surface = cx.session:surface(pane.title, {root = "main.omp-workspace", nodes = 1})
	return surface ~= nil and surface.main ~= nil and surface.main.p ~= nil
		and surface.main.p.role == "omp.workspace"
end

local function scan(cx: WindowCx?)
	timer = nil
	if cx == nil then
		return
	end
	local focused = cx.session:pane("@focused")
	if focused == nil or focused.tab == nil then
		return
	end
	local panes: {[number]: PaneInfo} = {}
	for _, pane in ipairs(cx.session:panes()) do
		panes[pane.pane] = pane
	end
	local now = tern.now()
	-- Daemon-side exits do not always emit pane_closed in the window.
	for pane_id, tab in pairs(workspace_tabs) do
		local pane = panes[pane_id]
		if pane == nil or pane.tab ~= tab then
			workspace_tabs[pane_id] = nil
			for other_id, other in pairs(panes) do
				if other.tab == tab or other_id == pane_id then
					pending[other_id] = now + 10000
				end
			end
		end
	end
	local again = false
	local balance = false
	for pane_id, deadline in pairs(pending) do
		local pane = panes[pane_id]
		if pane == nil or pane.tab == nil then
			pending[pane_id] = nil
		elseif pane.tab == focused.tab then
			if workspace_pane(cx, pane) then
				pending[pane_id] = nil
				workspace_tabs[pane_id] = pane.tab
				balance = true
			elseif now >= deadline then
				pending[pane_id] = nil
			else
				again = true
			end
		end
	end
	if balance then
		cx:command("equalize")
	end
	if again or next(workspace_tabs) ~= nil then
		timer = tern.timer(100, scan)
	end
end

local function watch(pane_id: number, cx: WindowCx)
	-- The pane title can arrive before its first native surface frame.
	pending[pane_id] = tern.now() + 10000
	if timer == nil then
		scan(cx)
	end
end

local function watch_tabs(cx: WindowCx)
	for _, pane in ipairs(cx.session:panes()) do
		pending[pane.pane] = tern.now() + 10000
	end
	if timer == nil then
		scan(cx)
	end
end

tern.on("window_start", watch_tabs)

tern.on("pane_created", function(ev: PaneEvent, cx: WindowCx)
	watch(ev.pane, cx)
end)

tern.on("title", function(ev: TitleEvent, cx: WindowCx)
	watch(ev.pane, cx)
end)

tern.on("pane_closed", function(ev: PaneEvent, cx: WindowCx)
	pending[ev.pane] = nil
	watch_tabs(cx)
end)

tern.on("focus", function(ev: FocusEvent, cx: WindowCx)
	for _, pane in ipairs(cx.session:panes()) do
		if pane.tab == ev.tab and pending[pane.pane] ~= nil then
			pending[pane.pane] = tern.now() + 10000
		end
	end
	if timer == nil then
		scan(cx)
	end
end)

-- Reloading an existing window plugin does not emit window_start again.
tern.timer(0, function(cx: WindowCx?)
	if cx ~= nil then
		watch_tabs(cx)
	end
end)
