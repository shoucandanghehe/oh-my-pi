--!strict

local pending: {[number]: number} = {}
local timer: TimerHandle? = nil

local function workspace_pane(cx: WindowCx, pane: number): boolean
	local surface = cx.session:surface(pane, {root = "main.omp-workspace", nodes = 1})
	return surface ~= nil and surface.main ~= nil and surface.main.p ~= nil
		and surface.main.p.role == "omp.workspace"
end

local function discover(cx: WindowCx, pane: number): boolean
	local tab = cx.session:tab_of(pane)
	if tab == nil then
		return true
	end
	if not workspace_pane(cx, pane) then
		return false
	end
	cx.layout:even(tab)
	return true
end

local function scan(cx: WindowCx?)
	timer = nil
	if cx == nil then
		return
	end
	local now = tern.now()
	for pane, deadline in pairs(pending) do
		if discover(cx, pane) or now >= deadline then
			pending[pane] = nil
		end
	end
	if next(pending) ~= nil then
		timer = tern.timer(100, scan)
	end
end

local function watch(pane: number, cx: WindowCx)
	if discover(cx, pane) then
		return
	end
	-- The pane title can arrive before its first native surface frame.
	pending[pane] = tern.now() + 10000
	if timer == nil then
		timer = tern.timer(100, scan)
	end
end

tern.on("window_start", function(cx: WindowCx)
	for _, pane in ipairs(cx.session:panes()) do
		watch(pane.pane, cx)
	end
end)

tern.on("pane_created", function(ev: PaneEvent, cx: WindowCx)
	watch(ev.pane, cx)
end)

tern.on("title", function(ev: TitleEvent, cx: WindowCx)
	watch(ev.pane, cx)
end)

tern.on("pane_closed", function(ev: PaneEvent, cx: WindowCx)
	pending[ev.pane] = nil
	local tabs: {[number]: boolean} = {}
	for _, pane in ipairs(cx.session:panes()) do
		if pane.tab ~= nil and workspace_pane(cx, pane.pane) then
			tabs[pane.tab] = true
		end
	end
	for tab in pairs(tabs) do
		cx.layout:even(tab)
	end
end)
