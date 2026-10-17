--!strict

local pending: { [string]: boolean } = {}

local function balancePending(cx: WindowCx)
	local focused = cx.session:pane("@focused")
	local shouldBalance = false
	for owner in pairs(pending) do
		-- Keep raw CLI ids as strings: Tern 0.9.5's numeric Lua round trip loses high bits.
		local pane = cx.session:pane(owner)
		if pane == nil then
			pending[owner] = nil
		elseif focused ~= nil and pane.tab ~= nil and pane.tab == focused.tab then
			pending[owner] = nil
			shouldBalance = true
		end
	end
	if shouldBalance then
		cx:command("equalize")
	end
end

tern.route.link(function(link: LinkRequest, cx: WindowCx): RouteDecision?
	local owner = link.url:match("^omp%-workspace://balance/(%d+)$")
	if owner == nil then
		return nil
	end
	pending[owner] = true
	balancePending(cx)
	return {handled = true}
end)

tern.on("focus", function(_, cx: WindowCx)
	balancePending(cx)
end)
