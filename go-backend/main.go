package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

type authFlow struct {
	Phone          string
	Environment    string
	DeviceID       string
	AuthMethod     string
	TempToken      string
	AuthToken      string
	FactorVerified bool
	CreatedAt      time.Time
}

type server struct {
	client *http.Client
	flows  map[string]*authFlow
	mu     sync.Mutex
}

func main() {
	s := &server{
		client: &http.Client{Timeout: 20 * time.Second},
		flows:  map[string]*authFlow{},
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/health", s.withCORS(s.health))
	mux.HandleFunc("/api/auth/start", s.withCORS(s.startLogin))
	mux.HandleFunc("/api/auth/verify-otp", s.withCORS(s.verifyOTP))
	mux.HandleFunc("/api/auth/verify-totp", s.withCORS(s.verifyTOTP))
	mux.HandleFunc("/api/auth/verify-mpin", s.withCORS(s.verifyMPIN))
	mux.HandleFunc("/api/auth/session-status", s.withCORS(s.sessionStatus))
	mux.HandleFunc("/api/market/instruments", s.withCORS(s.instruments))
	mux.HandleFunc("/api/market/scanner", s.withCORS(s.marketScanner))
	mux.HandleFunc("/api/market/option-chain", s.withCORS(s.optionChain))
	mux.HandleFunc("/api/market/oi-change", s.withCORS(s.oiChange))
	mux.HandleFunc("/api/market/time-lapse-skew", s.withCORS(s.timeLapseSkew))
	mux.HandleFunc("/api/market/iv-rank", s.withCORS(s.ivRank))
	mux.HandleFunc("/api/market/rolling-straddle", s.withCORS(s.rollingStraddle))
	mux.HandleFunc("/api/market/rolling-iv", s.withCORS(s.rollingIV))
	mux.HandleFunc("/api/market/iv-skew", s.withCORS(s.ivSkew))
	mux.HandleFunc("/api/market/weekly-vix", s.withCORS(s.weeklyVix))

	addr := ":" + env("GO_AUTH_PORT", "3002")
	log.Printf("Go Nubra auth server running on http://localhost%s", addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatal(err)
	}
}

func (s *server) withCORS(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if isAllowedOrigin(origin) {
			w.Header().Set("Access-Control-Allow-Origin", origin)
		}
		w.Header().Set("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type,x-session-token,x-device-id,x-raw-cookie")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next(w, r)
	}
}

func (s *server) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *server) startLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"detail": "method not allowed"})
		return
	}
	var req struct {
		Phone       string `json:"phone"`
		Environment string `json:"environment"`
		AuthMethod  string `json:"auth_method"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"detail": "invalid JSON body"})
		return
	}

	phone := digits(req.Phone)
	if len(phone) < 10 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"detail": "Enter a valid Nubra phone number."})
		return
	}
	environment := normalizeEnv(req.Environment)
	authMethod := "otp"
	if req.AuthMethod == "totp" {
		authMethod = "totp"
	}
	flowID := randomID()
	deviceID := "Nubra-OSS-" + phone

	if authMethod == "totp" {
		s.saveFlow(flowID, &authFlow{
			Phone: phone, Environment: environment, DeviceID: deviceID,
			AuthMethod: authMethod, CreatedAt: time.Now(),
		})
		writeJSON(w, http.StatusOK, map[string]any{
			"flow_id": flowID, "next_step": "totp", "masked_phone": maskPhone(phone),
			"environment": environment, "device_id": deviceID,
			"message": "TOTP mode enabled. Enter your authenticator code, then continue to MPIN verification.",
		})
		return
	}

	baseURL := nubraBaseURL(environment)
	first, status, err := s.nubraJSON(r.Context(), http.MethodPost, baseURL+"/sendphoneotp", map[string]string{
		"Content-Type": "application/json",
	}, map[string]any{"phone": phone, "skip_totp": false})
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"detail": "Unable to reach Nubra auth service: " + err.Error()})
		return
	}
	if status >= 400 {
		writeJSON(w, status, map[string]string{"detail": extractError(first, status)})
		return
	}
	tempToken := findString(first, "temp_token", 4)
	if tempToken == "" {
		writeJSON(w, http.StatusBadGateway, map[string]string{"detail": "Nubra did not return a temp token."})
		return
	}

	second, status, err := s.nubraJSON(r.Context(), http.MethodPost, baseURL+"/sendphoneotp", map[string]string{
		"Content-Type": "application/json",
		"x-temp-token": tempToken,
		"x-device-id":  deviceID,
	}, map[string]any{"phone": phone, "skip_totp": true})
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"detail": "Unable to reach Nubra auth service: " + err.Error()})
		return
	}
	if status >= 400 {
		writeJSON(w, status, map[string]string{"detail": extractError(second, status)})
		return
	}
	if nextTemp := findString(second, "temp_token", 4); nextTemp != "" {
		tempToken = nextTemp
	}

	s.saveFlow(flowID, &authFlow{
		Phone: phone, Environment: environment, DeviceID: deviceID,
		AuthMethod: authMethod, TempToken: tempToken, CreatedAt: time.Now(),
	})
	writeJSON(w, http.StatusOK, map[string]any{
		"flow_id": flowID, "next_step": "otp", "masked_phone": maskPhone(phone),
		"environment": environment, "device_id": deviceID,
		"message": "OTP sent. Verify the SMS OTP, then continue to MPIN verification.",
	})
}

func (s *server) verifyOTP(w http.ResponseWriter, r *http.Request) {
	var req struct {
		FlowID string `json:"flow_id"`
		OTP    string `json:"otp"`
	}
	if !s.decodePost(w, r, &req) {
		return
	}
	flow := s.getFlow(req.FlowID)
	if flow == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"detail": "Login flow not found."})
		return
	}
	if flow.AuthMethod != "otp" {
		writeJSON(w, http.StatusConflict, map[string]string{"detail": "This login flow is configured for TOTP."})
		return
	}
	if !isNumeric(req.OTP) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"detail": "OTP must be numeric."})
		return
	}

	payload, status, err := s.nubraJSON(r.Context(), http.MethodPost, nubraBaseURL(flow.Environment)+"/verifyphoneotp", map[string]string{
		"Content-Type": "application/json",
		"x-temp-token": flow.TempToken,
		"x-device-id":  flow.DeviceID,
	}, map[string]any{"phone": flow.Phone, "otp": req.OTP})
	s.finishFactor(w, req.FlowID, flow, payload, status, err, "OTP")
}

func (s *server) verifyTOTP(w http.ResponseWriter, r *http.Request) {
	var req struct {
		FlowID string `json:"flow_id"`
		TOTP   string `json:"totp"`
	}
	if !s.decodePost(w, r, &req) {
		return
	}
	flow := s.getFlow(req.FlowID)
	if flow == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"detail": "Login flow not found."})
		return
	}
	if flow.AuthMethod != "totp" {
		writeJSON(w, http.StatusConflict, map[string]string{"detail": "This login flow is configured for SMS OTP."})
		return
	}
	if !isNumeric(req.TOTP) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"detail": "TOTP must be numeric."})
		return
	}

	payload, status, err := s.nubraJSON(r.Context(), http.MethodPost, nubraBaseURL(flow.Environment)+"/totp/login", map[string]string{
		"Content-Type": "application/json",
		"x-device-id":  flow.DeviceID,
	}, map[string]any{"phone": flow.Phone, "totp": toInt(req.TOTP)})
	s.finishFactor(w, req.FlowID, flow, payload, status, err, "TOTP")
}

func (s *server) finishFactor(w http.ResponseWriter, flowID string, flow *authFlow, payload map[string]any, status int, err error, label string) {
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"detail": "Unable to reach Nubra auth service: " + err.Error()})
		return
	}
	if status >= 400 {
		writeJSON(w, status, map[string]string{"detail": extractError(payload, status)})
		return
	}
	authToken := findString(payload, "auth_token", 4)
	if authToken == "" {
		writeJSON(w, http.StatusBadGateway, map[string]string{"detail": fmt.Sprintf("Nubra did not return auth_token after %s verification.", label)})
		return
	}
	s.mu.Lock()
	flow.AuthToken = authToken
	flow.FactorVerified = true
	s.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"flow_id": flowID, "next_step": "mpin", "message": label + " accepted. Continue with MPIN verification."})
}

func (s *server) verifyMPIN(w http.ResponseWriter, r *http.Request) {
	var req struct {
		FlowID string `json:"flow_id"`
		MPIN   string `json:"mpin"`
	}
	if !s.decodePost(w, r, &req) {
		return
	}
	flow := s.getFlow(req.FlowID)
	if flow == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"detail": "Login flow not found."})
		return
	}
	if !flow.FactorVerified || flow.AuthToken == "" {
		writeJSON(w, http.StatusConflict, map[string]string{"detail": "OTP or TOTP must be verified first."})
		return
	}
	if !isNumeric(req.MPIN) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"detail": "MPIN must be numeric."})
		return
	}

	baseURL := nubraBaseURL(flow.Environment)
	payload, status, err := s.nubraJSON(r.Context(), http.MethodPost, baseURL+"/verifypin", map[string]string{
		"Content-Type":  "application/json",
		"Authorization": "Bearer " + flow.AuthToken,
		"x-device-id":   flow.DeviceID,
	}, map[string]any{"pin": req.MPIN})
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"detail": "Unable to reach Nubra auth service: " + err.Error()})
		return
	}
	if status >= 400 {
		writeJSON(w, status, map[string]string{"detail": extractError(payload, status)})
		return
	}
	sessionToken := firstNonEmpty(findString(payload, "session_token", 4), findString(payload, "token", 4))
	if sessionToken == "" {
		writeJSON(w, http.StatusBadGateway, map[string]string{"detail": "Nubra did not return session_token after MPIN verification."})
		return
	}

	accountID := s.fetchClientCode(r.Context(), baseURL, sessionToken, flow.DeviceID)
	if accountID == "" {
		accountID = "NUBRA-" + flow.Phone[len(flow.Phone)-4:]
	}
	s.deleteFlow(req.FlowID)

	writeJSON(w, http.StatusOK, map[string]any{
		"access_token": sessionToken, "refresh_token": randomID(),
		"user_name": "Nubra User", "account_id": accountID, "device_id": flow.DeviceID,
		"environment": flow.Environment, "broker": "Nubra", "expires_in": 3600,
		"message": "Nubra session established using the REST API login flow.",
	})
}

func (s *server) sessionStatus(w http.ResponseWriter, r *http.Request) {
	var req struct {
		SessionToken string `json:"session_token"`
		DeviceID     string `json:"device_id"`
		Environment  string `json:"environment"`
	}
	if !s.decodePost(w, r, &req) {
		return
	}
	if req.SessionToken == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"detail": "session_token is required."})
		return
	}
	if req.DeviceID == "" {
		req.DeviceID = "web"
	}
	environment := normalizeEnv(req.Environment)
	baseURL := nubraBaseURL(environment)
	payload, status, err := s.nubraJSON(r.Context(), http.MethodGet, baseURL+"/userinfo", map[string]string{
		"Authorization": "Bearer " + req.SessionToken,
		"x-device-id":   req.DeviceID,
		"Accept":        "application/json",
	}, nil)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"detail": "Unable to reach Nubra auth service: " + err.Error()})
		return
	}
	if status == http.StatusUnauthorized || status == http.StatusForbidden || status == 440 {
		writeJSON(w, http.StatusOK, map[string]any{"active": false, "environment": environment, "expires_at_utc": nil, "account_id": nil, "message": extractError(payload, status)})
		return
	}
	if status >= 400 {
		writeJSON(w, status, map[string]string{"detail": extractError(payload, status)})
		return
	}
	accountID := s.fetchClientCode(r.Context(), baseURL, req.SessionToken, req.DeviceID)
	writeJSON(w, http.StatusOK, map[string]any{"active": true, "environment": environment, "expires_at_utc": nil, "account_id": nullableString(accountID), "message": "Session is active."})
}

func (s *server) decodePost(w http.ResponseWriter, r *http.Request, dest any) bool {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"detail": "method not allowed"})
		return false
	}
	if err := decodeJSON(r, dest); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"detail": "invalid JSON body"})
		return false
	}
	return true
}

func (s *server) nubraJSON(ctx context.Context, method, url string, headers map[string]string, body any) (map[string]any, int, error) {
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return nil, 0, err
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, url, reader)
	if err != nil {
		return nil, 0, err
	}
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	res, err := s.client.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, res.StatusCode, err
	}
	var payload map[string]any
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &payload); err != nil {
			payload = map[string]any{"_raw": string(raw)}
		}
	} else {
		payload = map[string]any{}
	}
	return payload, res.StatusCode, nil
}

func (s *server) fetchClientCode(ctx context.Context, baseURL, sessionToken, deviceID string) string {
	paths := []string{"portfolio/user_funds_and_margin", "portfolio/v2/positions", "portfolio/holdings", "userinfo"}
	for _, path := range paths {
		payload, status, err := s.nubraJSON(ctx, http.MethodGet, baseURL+"/"+path, map[string]string{
			"Authorization": "Bearer " + sessionToken,
			"Content-Type":  "application/json",
			"Accept":        "application/json",
			"x-device-id":   deviceID,
		}, nil)
		if err == nil && status < 400 {
			if code := findString(payload, "client_code", 4); code != "" {
				return code
			}
		}
	}
	return ""
}

func (s *server) saveFlow(id string, flow *authFlow) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cleanupLocked()
	s.flows[id] = flow
}

func (s *server) getFlow(id string) *authFlow {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cleanupLocked()
	return s.flows[id]
}

func (s *server) deleteFlow(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.flows, id)
}

func (s *server) cleanupLocked() {
	cutoff := time.Now().Add(-15 * time.Minute)
	for id, flow := range s.flows {
		if flow.CreatedAt.Before(cutoff) {
			delete(s.flows, id)
		}
	}
}

func decodeJSON(r *http.Request, dest any) error {
	defer r.Body.Close()
	return json.NewDecoder(r.Body).Decode(dest)
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func nubraBaseURL(environment string) string {
	if strings.ToUpper(environment) == "UAT" {
		return env("NUBRA_UAT_BASE_URL", "https://uat-api.nubra.io")
	}
	return env("NUBRA_PROD_BASE_URL", "https://api.nubra.io")
}

func normalizeEnv(value string) string {
	if strings.ToUpper(value) == "UAT" {
		return "UAT"
	}
	return "PROD"
}

func normalizeExchange(value string) string {
	switch strings.ToUpper(strings.TrimSpace(value)) {
	case "BSE":
		return "BSE"
	case "MCX":
		return "MCX"
	default:
		return "NSE"
	}
}

func env(key, fallback string) string {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	return strings.TrimRight(value, "/")
}

func digits(value string) string {
	re := regexp.MustCompile(`\D+`)
	return re.ReplaceAllString(value, "")
}

func isNumeric(value string) bool {
	return regexp.MustCompile(`^\d+$`).MatchString(value)
}

func toInt(value string) int {
	var n int
	for _, ch := range value {
		n = n*10 + int(ch-'0')
	}
	return n
}

func maskPhone(phone string) string {
	if len(phone) < 4 {
		return phone
	}
	return phone[:2] + "******" + phone[len(phone)-2:]
}

func randomID() string {
	buf := make([]byte, 18)
	if _, err := rand.Read(buf); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return base64.RawURLEncoding.EncodeToString(buf)
}

func extractError(payload map[string]any, status int) string {
	for _, key := range []string{"message", "detail", "error"} {
		if value := findString(payload, key, 4); value != "" {
			return value
		}
	}
	return fmt.Sprintf("Nubra request failed with status %d.", status)
}

func findString(value any, fieldName string, depth int) string {
	if depth < 0 || value == nil {
		return ""
	}
	switch typed := value.(type) {
	case map[string]any:
		if raw, ok := typed[fieldName]; ok {
			if str, ok := raw.(string); ok && strings.TrimSpace(str) != "" {
				return strings.TrimSpace(str)
			}
		}
		for _, nested := range typed {
			if found := findString(nested, fieldName, depth-1); found != "" {
				return found
			}
		}
	case []any:
		for _, nested := range typed {
			if found := findString(nested, fieldName, depth-1); found != "" {
				return found
			}
		}
	}
	return ""
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func nullableString(value string) any {
	if value == "" {
		return nil
	}
	return value
}

// ── MARKET SCANNER ──────────────────────────────────────────────────────────

// scannerSymbols — verified against the Nifty300 universe CSV used by Nubra refdata.
var scannerSymbols = []string{
	"HDFCBANK", "INFY", "ICICIBANK", "KOTAKBANK", "AXISBANK",
	"HINDUNILVR", "BAJFINANCE", "BHARTIARTL", "ITC", "ASIANPAINT",
	"CIPLA", "HCLTECH", "ADANIENT", "ADANIPORTS", "COALINDIA",
	"DRREDDY", "HINDALCO", "JSWSTEEL", "APOLLOHOSP", "DMART",
	"BAJAJFINSV", "EICHERMOT", "HEROMOTOCO", "DIVISLAB", "BPCL",
	"GAIL", "HAVELLS", "LT", "BERGEPAINT", "ICICIPRULI",
}

type scannerRequest struct {
	SessionToken string   `json:"session_token"`
	DeviceID     string   `json:"device_id"`
	Environment  string   `json:"environment"`
	Exchange     string   `json:"exchange"`
	Symbols      []string `json:"symbols"`
}

type scannerRow struct {
	Rank           int     `json:"rank"`
	Symbol         string  `json:"symbol"`
	DisplayName    string  `json:"display_name"`
	Exchange       string  `json:"exchange"`
	LastPrice      float64 `json:"last_price"`
	CurrentVolume  int64   `json:"current_volume"`
	AverageVolume  int64   `json:"average_volume"`
	VolumeRatio    float64 `json:"volume_ratio"`
	PriceChangePct float64 `json:"price_change_pct"`
	IsGreen        bool    `json:"is_green"`
}

type scannerResponse struct {
	Status  string       `json:"status"`
	Message string       `json:"message"`
	Rows    []scannerRow `json:"rows"`
}

type instrumentsRequest struct {
	SessionToken string `json:"session_token"`
	DeviceID     string `json:"device_id"`
	Environment  string `json:"environment"`
	Exchange     string `json:"exchange"`
	Date         string `json:"date"`
}

func (s *server) instruments(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"detail": "method not allowed"})
		return
	}
	var req instrumentsRequest
	if err := decodeJSON(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"detail": "invalid JSON body"})
		return
	}
	if req.SessionToken == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"detail": "session_token is required"})
		return
	}
	if req.DeviceID == "" {
		req.DeviceID = "Nubra-OSS-refdata"
	}
	exchange := normalizeExchange(req.Exchange)
	if req.Date == "" {
		now := time.Now().In(time.FixedZone("IST", 5*3600+30*60))
		req.Date = now.Format("2006-01-02")
	}
	if !regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`).MatchString(req.Date) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"detail": "date must be YYYY-MM-DD"})
		return
	}

	refURL := nubraBaseURL(req.Environment) + "/refdata/refdata/" + url.PathEscape(req.Date) + "?exchange=" + url.QueryEscape(exchange)
	payload, status, err := s.nubraJSON(r.Context(), http.MethodGet, refURL, map[string]string{
		"Authorization": "Bearer " + req.SessionToken,
		"Accept":        "application/json",
		"x-device-id":   req.DeviceID,
	}, nil)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"detail": "Nubra refdata error: " + err.Error()})
		return
	}
	if status >= 400 {
		writeJSON(w, status, map[string]string{"detail": extractError(payload, status)})
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

// timeseriesPayload mirrors the Nubra /charts/timeseries request body.
// intraDay must be false when fetching historical windows; true means "current day only".
func timeseriesPayload(symbols []string, exchange, interval, startDate, endDate string) map[string]any {
	return map[string]any{
		"query": []any{
			map[string]any{
				"exchange":  exchange,
				"type":      "STOCK",
				"values":    symbols,
				"fields":    []string{"open", "close", "cumulative_volume"},
				"startDate": startDate,
				"endDate":   endDate,
				"interval":  interval,
				"intraDay":  false,
				"realTime":  false,
			},
		},
	}
}

func (s *server) marketScanner(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"detail": "method not allowed"})
		return
	}
	var req scannerRequest
	if err := decodeJSON(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"detail": "invalid JSON body"})
		return
	}
	if req.SessionToken == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"detail": "session_token is required"})
		return
	}
	if req.DeviceID == "" {
		req.DeviceID = "Nubra-OSS-scanner"
	}

	baseURL := nubraBaseURL(req.Environment)
	exchange := normalizeExchange(req.Exchange)
	symbols := scannerSymbols
	if len(req.Symbols) > 0 {
		symbols = make([]string, 0, len(req.Symbols))
		for _, symbol := range req.Symbols {
			symbol = strings.ToUpper(strings.TrimSpace(symbol))
			if symbol != "" {
				symbols = append(symbols, symbol)
			}
		}
	}
	if len(symbols) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"detail": "symbols must contain at least one instrument"})
		return
	}
	now := time.Now().In(time.FixedZone("IST", 5*3600+30*60))

	// Fetch 2 days of 5m bars: yesterday open to now, so we have prior-day baseline.
	start := now.AddDate(0, 0, -2).Format("2006-01-02") + "T03:30:00.000Z" // ~IST 09:00 D-2
	end := now.UTC().Format("2006-01-02T15:04:05.000Z")

	// Fetch in batches of 5 (Nubra documented limit per request).
	type symbolData struct {
		candles []struct {
			ts                  int64
			open, close, cumVol float64
		}
	}
	allData := map[string]symbolData{}

	for i := 0; i < len(symbols); i += 5 {
		end2 := i + 5
		if end2 > len(symbols) {
			end2 = len(symbols)
		}
		batch := symbols[i:end2]

		body := timeseriesPayload(batch, exchange, "5m", start, end)
		payload, status, err := s.nubraJSON(r.Context(), http.MethodPost, baseURL+"/charts/timeseries",
			map[string]string{
				"Authorization": "Bearer " + req.SessionToken,
				"Content-Type":  "application/json",
				"Accept":        "application/json",
				"x-device-id":   req.DeviceID,
			}, body)
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"detail": "Nubra timeseries error: " + err.Error()})
			return
		}
		if status >= 400 {
			writeJSON(w, status, map[string]string{"detail": extractError(payload, status)})
			return
		}

		// Parse Nubra response: result[].values[]{symbol: {open:[{ts,v}], close:[...], cumulative_volume:[...]}}
		results, _ := payload["result"].([]any)
		for _, resultItem := range results {
			ri, _ := resultItem.(map[string]any)
			values, _ := ri["values"].([]any)
			for _, stockEntry := range values {
				se, _ := stockEntry.(map[string]any)
				for sym, symChart := range se {
					sc, _ := symChart.(map[string]any)
					openPts, _ := sc["open"].([]any)
					closePts, _ := sc["close"].([]any)
					cumVolPts, _ := sc["cumulative_volume"].([]any)

					// Build a map ts->cumVol for easy lookup.
					type pt struct {
						ts int64
						v  float64
					}
					toPoints := func(arr []any) []pt {
						out := make([]pt, 0, len(arr))
						for _, item := range arr {
							m, _ := item.(map[string]any)
							ts, _ := m["ts"].(float64)
							v, _ := m["v"].(float64)
							out = append(out, pt{int64(ts), v})
						}
						return out
					}
					openPoints := toPoints(openPts)
					closePoints := toPoints(closePts)
					cumVolPoints := toPoints(cumVolPts)

					// Align by index (Nubra returns same-length parallel arrays).
					n := len(openPoints)
					if n > len(closePoints) {
						n = len(closePoints)
					}
					if n > len(cumVolPoints) {
						n = len(cumVolPoints)
					}

					type candle struct {
						ts                  int64
						open, close, cumVol float64
					}
					candles := make([]candle, n)
					for idx := 0; idx < n; idx++ {
						candles[idx] = candle{
							ts:     openPoints[idx].ts,
							open:   openPoints[idx].v / 100.0,
							close:  closePoints[idx].v / 100.0,
							cumVol: cumVolPoints[idx].v,
						}
					}

					// Derive per-bucket volume from cumulative.
					bucketVols := make([]float64, n)
					for idx := 0; idx < n; idx++ {
						if idx == 0 {
							bucketVols[idx] = candles[idx].cumVol
						} else {
							diff := candles[idx].cumVol - candles[idx-1].cumVol
							if diff < 0 {
								diff = candles[idx].cumVol
							} // new session reset
							bucketVols[idx] = diff
						}
					}

					type sd struct {
						candles []struct {
							ts                  int64
							open, close, cumVol float64
						}
					}
					_ = sd{}

					allData[strings.ToUpper(sym)] = symbolData{
						candles: func() []struct {
							ts                  int64
							open, close, cumVol float64
						} {
							out := make([]struct {
								ts                  int64
								open, close, cumVol float64
							}, n)
							for idx := 0; idx < n; idx++ {
								out[idx] = struct {
									ts                  int64
									open, close, cumVol float64
								}{
									candles[idx].ts, candles[idx].open, candles[idx].close, bucketVols[idx],
								}
							}
							return out
						}(),
					}
				}
			}
		}
	}

	// Build scanner rows: compare latest candle volume to average of same candle-index on prior days.
	nowNano := now.UnixNano()
	// IST midnight today in nanoseconds.
	todayMidnightIST := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location()).UnixNano()

	rows := make([]scannerRow, 0, len(symbols))
	for _, sym := range symbols {
		data, ok := allData[sym]
		if !ok || len(data.candles) == 0 {
			continue
		}

		// Split into today vs prior candles.
		var todayCandles, priorCandles []struct {
			ts                  int64
			open, close, cumVol float64
		}
		for _, c := range data.candles {
			if c.ts >= todayMidnightIST {
				todayCandles = append(todayCandles, c)
			} else {
				priorCandles = append(priorCandles, c)
			}
		}
		if len(todayCandles) == 0 {
			continue
		}

		// Current candle = last today candle. Check it's within last 15 minutes.
		latest := todayCandles[len(todayCandles)-1]
		if nowNano-latest.ts > int64(15*time.Minute) {
			// Stale — skip.
			continue
		}

		currentVol := latest.cumVol // already bucket vol
		currentIdx := len(todayCandles) - 1

		// Average volume of same candle index on prior days.
		var avgVol float64
		if len(priorCandles) > 0 && currentIdx < len(priorCandles) {
			// Use same slot from prior day as a rough baseline.
			// Group prior candles by day and pick the candle at same index.
			const candlesPerDay = 75 // ~375 min / 5 min
			avgSamples := 0
			totalVol := 0.0
			for dayStart := 0; dayStart+currentIdx < len(priorCandles); dayStart += candlesPerDay {
				idx := dayStart + currentIdx
				if idx < len(priorCandles) {
					totalVol += priorCandles[idx].cumVol
					avgSamples++
				}
			}
			if avgSamples > 0 {
				avgVol = totalVol / float64(avgSamples)
			}
		}
		if avgVol < 1000 {
			avgVol = 1000 // floor to avoid division noise
		}

		ratio := currentVol / avgVol
		if ratio < 1.5 {
			continue // not a breakout
		}

		ltp := latest.close
		open := todayCandles[0].open
		pctChange := 0.0
		if open > 0 {
			pctChange = (ltp - open) / open * 100
		}

		rows = append(rows, scannerRow{
			Symbol:         sym,
			DisplayName:    sym,
			Exchange:       exchange,
			LastPrice:      ltp,
			CurrentVolume:  int64(currentVol),
			AverageVolume:  int64(avgVol),
			VolumeRatio:    ratio,
			PriceChangePct: pctChange,
			IsGreen:        ltp >= open,
		})
	}

	// Sort by volume ratio descending and assign ranks.
	for i := 0; i < len(rows); i++ {
		for j := i + 1; j < len(rows); j++ {
			if rows[j].VolumeRatio > rows[i].VolumeRatio {
				rows[i], rows[j] = rows[j], rows[i]
			}
		}
	}
	for i := range rows {
		rows[i].Rank = i + 1
	}

	msg := fmt.Sprintf("Volume scanner found %d breakout(s) across %d %s symbol(s).", len(rows), len(symbols), exchange)
	if len(rows) == 0 {
		msg = "No volume breakouts detected right now. Market may be closed or volume is below the 1.5× threshold."
	}
	writeJSON(w, http.StatusOK, scannerResponse{Status: "success", Message: msg, Rows: rows})
}

// ── OPTION CHAIN ────────────────────────────────────────────────────────────

type optionChainRequest struct {
	SessionToken string `json:"session_token"`
	DeviceID     string `json:"device_id"`
	Environment  string `json:"environment"`
	Exchange     string `json:"exchange"`
	Instrument   string `json:"instrument"` // e.g. "NIFTY"
	Expiry       string `json:"expiry"`     // e.g. "20250626" — empty = nearest
}

type optionLeg struct {
	RefID     int     `json:"ref_id"`
	Strike    float64 `json:"strike"` // paise → div by 100 for display
	LTP       float64 `json:"ltp"`    // paise → div by 100
	LTPChange float64 `json:"ltp_chg"`
	IV        float64 `json:"iv"`
	Delta     float64 `json:"delta"`
	Gamma     float64 `json:"gamma"`
	Theta     float64 `json:"theta"`
	Vega      float64 `json:"vega"`
	OI        int64   `json:"oi"`
	OIChange  float64 `json:"oi_chg"`
	Volume    int64   `json:"volume"`
}

type optionChainResponse struct {
	Instrument   string      `json:"instrument"`
	Exchange     string      `json:"exchange"`
	Expiry       string      `json:"expiry"`
	AllExpiries  []string    `json:"all_expiries"`
	ATM          float64     `json:"atm"`
	CurrentPrice float64     `json:"current_price"`
	CE           []optionLeg `json:"ce"`
	PE           []optionLeg `json:"pe"`
	PCR          float64     `json:"pcr"`
	TotalCEOI    int64       `json:"total_ce_oi"`
	TotalPEOI    int64       `json:"total_pe_oi"`
}

type oiChangeRequest struct {
	SessionToken string    `json:"session_token"`
	DeviceID     string    `json:"device_id"`
	Environment  string    `json:"environment"`
	Exchange     string    `json:"exchange"`
	Instrument   string    `json:"instrument"`
	Expiry       string    `json:"expiry"`
	StartTime    string    `json:"start_time"`
	EndTime      string    `json:"end_time"`
	Strikes      []float64 `json:"strikes"`
}

type oiChangePoint struct {
	Strike float64 `json:"strike"`
	Call   float64 `json:"call"`
	Put    float64 `json:"put"`
}

type oiChangeResponse struct {
	Instrument string          `json:"instrument"`
	Exchange   string          `json:"exchange"`
	Expiry     string          `json:"expiry"`
	StartTime  string          `json:"start_time"`
	EndTime    string          `json:"end_time"`
	Points     []oiChangePoint `json:"points"`
	Message    string          `json:"message"`
}

type timeLapseSkewRequest struct {
	SessionToken string    `json:"session_token"`
	DeviceID     string    `json:"device_id"`
	Environment  string    `json:"environment"`
	Exchange     string    `json:"exchange"`
	Instrument   string    `json:"instrument"`
	Expiry       string    `json:"expiry"`
	Strikes      []float64 `json:"strikes"`
	ATM          float64   `json:"atm"`
	Time         string    `json:"time"`
	Offsets      []int     `json:"offsets"`
}

type timeLapseSkewPoint struct {
	Strike float64 `json:"strike"`
	IV     float64 `json:"iv"`
	CallIV float64 `json:"call_iv,omitempty"`
	PutIV  float64 `json:"put_iv,omitempty"`
}

type timeLapseSkewSeries struct {
	Key    string               `json:"key"`
	Label  string               `json:"label"`
	Time   string               `json:"time"`
	Points []timeLapseSkewPoint `json:"points"`
}

type timeLapseSkewResponse struct {
	Instrument string                `json:"instrument"`
	Exchange   string                `json:"exchange"`
	Expiry     string                `json:"expiry"`
	ATM        float64               `json:"atm"`
	Series     []timeLapseSkewSeries `json:"series"`
	Message    string                `json:"message"`
}

func (s *server) optionChain(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"detail": "method not allowed"})
		return
	}
	var req optionChainRequest
	if err := decodeJSON(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"detail": "invalid JSON"})
		return
	}
	if req.SessionToken == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"detail": "session_token required"})
		return
	}
	if req.DeviceID == "" {
		req.DeviceID = "Nubra-OSS-desk"
	}
	if req.Instrument == "" {
		req.Instrument = "NIFTY"
	}

	baseURL := nubraBaseURL(req.Environment)
	exchange := normalizeExchange(req.Exchange)
	chainURL := baseURL + "/optionchains/" + url.PathEscape(req.Instrument) + "?exchange=" + url.QueryEscape(exchange)
	if req.Expiry != "" {
		chainURL += "&expiry=" + url.QueryEscape(req.Expiry)
	}

	payload, status, err := s.nubraJSON(r.Context(), http.MethodGet, chainURL, map[string]string{
		"Authorization": "Bearer " + req.SessionToken,
		"Accept":        "application/json",
		"x-device-id":   req.DeviceID,
	}, nil)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"detail": err.Error()})
		return
	}
	if status >= 400 {
		writeJSON(w, status, map[string]string{"detail": extractError(payload, status)})
		return
	}

	chain, _ := payload["chain"].(map[string]any)
	if chain == nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"detail": "unexpected response from Nubra"})
		return
	}

	parseLeg := func(item map[string]any) optionLeg {
		asFloat := func(v any) float64 {
			switch x := v.(type) {
			case float64:
				return x
			case int64:
				return float64(x)
			}
			return 0
		}
		asInt64 := func(v any) int64 {
			switch x := v.(type) {
			case float64:
				return int64(x)
			case int64:
				return x
			}
			return 0
		}
		return optionLeg{
			RefID:     int(asInt64(item["ref_id"])),
			Strike:    asFloat(item["sp"]) / 100.0,
			LTP:       asFloat(item["ltp"]) / 100.0,
			LTPChange: asFloat(item["ltpchg"]),
			IV:        asFloat(item["iv"]),
			Delta:     asFloat(item["delta"]),
			Gamma:     asFloat(item["gamma"]),
			Theta:     asFloat(item["theta"]),
			Vega:      asFloat(item["vega"]),
			OI:        asInt64(item["oi"]),
			OIChange:  asFloat(item["oi_chg"]),
			Volume:    asInt64(item["volume"]),
		}
	}

	parseLegs := func(arr []any) []optionLeg {
		out := make([]optionLeg, 0, len(arr))
		for _, item := range arr {
			m, ok := item.(map[string]any)
			if !ok {
				continue
			}
			out = append(out, parseLeg(m))
		}
		return out
	}

	ceArr, _ := chain["ce"].([]any)
	peArr, _ := chain["pe"].([]any)
	ceLegs := parseLegs(ceArr)
	peLegs := parseLegs(peArr)

	var totalCEOI, totalPEOI int64
	for _, l := range ceLegs {
		totalCEOI += l.OI
	}
	for _, l := range peLegs {
		totalPEOI += l.OI
	}
	pcr := 0.0
	if totalCEOI > 0 {
		pcr = float64(totalPEOI) / float64(totalCEOI)
	}

	atm, _ := chain["atm"].(float64)
	cp, _ := chain["cp"].(float64)
	expiry, _ := chain["expiry"].(string)

	allExpiriesRaw, _ := chain["all_expiries"].([]any)
	allExpiries := make([]string, 0, len(allExpiriesRaw))
	for _, e := range allExpiriesRaw {
		if s, ok := e.(string); ok {
			allExpiries = append(allExpiries, s)
		}
	}

	writeJSON(w, http.StatusOK, optionChainResponse{
		Instrument:   req.Instrument,
		Exchange:     exchange,
		Expiry:       expiry,
		AllExpiries:  allExpiries,
		ATM:          atm / 100.0,
		CurrentPrice: cp / 100.0,
		CE:           ceLegs,
		PE:           peLegs,
		PCR:          pcr,
		TotalCEOI:    totalCEOI,
		TotalPEOI:    totalPEOI,
	})
}

// ── IV RANK ──────────────────────────────────────────────────────────────────

func (s *server) oiChange(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"detail": "method not allowed"})
		return
	}
	var req oiChangeRequest
	if err := decodeJSON(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"detail": "invalid JSON"})
		return
	}
	if req.SessionToken == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"detail": "session_token required"})
		return
	}
	if req.DeviceID == "" {
		req.DeviceID = "Nubra-OSS-desk"
	}
	if req.Instrument == "" {
		req.Instrument = "NIFTY"
	}
	if req.Expiry == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"detail": "expiry required"})
		return
	}
	if len(req.Strikes) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"detail": "strikes required"})
		return
	}
	startTime, err := time.Parse(time.RFC3339, req.StartTime)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"detail": "start_time must be RFC3339"})
		return
	}
	endTime, err := time.Parse(time.RFC3339, req.EndTime)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"detail": "end_time must be RFC3339"})
		return
	}
	if !startTime.Before(endTime) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"detail": "start_time must be before end_time"})
		return
	}

	exchange := normalizeExchange(req.Exchange)
	scaledStrikes := make([]int, 0, len(req.Strikes))
	seen := map[int]bool{}
	for _, strike := range req.Strikes {
		if strike <= 0 {
			continue
		}
		scaled := int(math.Round(strike * 100))
		if !seen[scaled] {
			scaledStrikes = append(scaledStrikes, scaled)
			seen[scaled] = true
		}
	}
	sort.Ints(scaledStrikes)
	if len(scaledStrikes) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"detail": "strikes required"})
		return
	}

	minStrike := scaledStrikes[0]
	maxStrike := scaledStrikes[len(scaledStrikes)-1]
	queryItem := func(t time.Time) map[string]any {
		return map[string]any{
			"exchange":  exchange,
			"asset":     strings.ToUpper(req.Instrument),
			"expiries":  []string{req.Expiry},
			"minStrike": minStrike,
			"maxStrike": maxStrike,
			"strikes":   scaledStrikes,
			"fields":    []string{"cumulative_oi"},
			"time":      t.UTC().Format("2006-01-02T15:04:05.000Z"),
		}
	}
	body := map[string]any{"query": []any{queryItem(endTime), queryItem(startTime)}}

	payload, status, err := s.nubraJSON(r.Context(), http.MethodPost, nubraBaseURL(req.Environment)+"/charts/multistrike?chart=Open_Interest_Change", map[string]string{
		"Authorization": "Bearer " + req.SessionToken,
		"Content-Type":  "application/json",
		"Accept":        "application/json",
		"x-device-id":   req.DeviceID,
	}, body)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"detail": "Nubra multistrike error: " + err.Error()})
		return
	}
	if status >= 400 {
		writeJSON(w, status, map[string]string{"detail": extractError(payload, status)})
		return
	}

	snapshots := extractOISnapshots(payload, exchange, strings.ToUpper(req.Instrument), req.Expiry)
	if len(snapshots) < 2 {
		writeJSON(w, http.StatusBadGateway, map[string]string{"detail": "Nubra multistrike response did not contain two OI snapshots"})
		return
	}
	startSnap := snapshots[0]
	endSnap := snapshots[len(snapshots)-1]
	points := make([]oiChangePoint, 0, len(scaledStrikes))
	for _, scaled := range scaledStrikes {
		startLegs := startSnap[scaled]
		endLegs := endSnap[scaled]
		points = append(points, oiChangePoint{
			Strike: float64(scaled) / 100.0,
			Call:   (endLegs.CE - startLegs.CE) / 100000.0,
			Put:    (endLegs.PE - startLegs.PE) / 100000.0,
		})
	}
	message := fmt.Sprintf("OI change calculated across %d strikes.", len(points))
	if oiChangeAllZero(points) {
		if fallback, ok := s.optionChainOIChangeFallback(r.Context(), req, exchange, scaledStrikes); ok {
			points = fallback
			message = fmt.Sprintf("OI change used option-chain oi_chg fallback across %d strikes because multistrike snapshots were flat.", len(points))
		}
	}

	writeJSON(w, http.StatusOK, oiChangeResponse{
		Instrument: strings.ToUpper(req.Instrument),
		Exchange:   exchange,
		Expiry:     req.Expiry,
		StartTime:  startTime.UTC().Format(time.RFC3339),
		EndTime:    endTime.UTC().Format(time.RFC3339),
		Points:     points,
		Message:    message,
	})
}

func oiChangeAllZero(points []oiChangePoint) bool {
	if len(points) == 0 {
		return true
	}
	for _, point := range points {
		if math.Abs(point.Call)+math.Abs(point.Put) > 0.005 {
			return false
		}
	}
	return true
}

func (s *server) optionChainOIChangeFallback(ctx context.Context, req oiChangeRequest, exchange string, scaledStrikes []int) ([]oiChangePoint, bool) {
	chainURL := nubraBaseURL(req.Environment) + "/optionchains/" + url.PathEscape(req.Instrument) + "?exchange=" + url.QueryEscape(exchange)
	if req.Expiry != "" {
		chainURL += "&expiry=" + url.QueryEscape(req.Expiry)
	}
	payload, status, err := s.nubraJSON(ctx, http.MethodGet, chainURL, map[string]string{
		"Authorization": "Bearer " + req.SessionToken,
		"Accept":        "application/json",
		"x-device-id":   req.DeviceID,
	}, nil)
	if err != nil || status >= 400 {
		return nil, false
	}
	chain, _ := payload["chain"].(map[string]any)
	if chain == nil {
		return nil, false
	}
	parse := func(raw any) map[int]float64 {
		out := map[int]float64{}
		arr, _ := raw.([]any)
		for _, item := range arr {
			m, _ := item.(map[string]any)
			strike := int(math.Round(jsonNumber(m["sp"])))
			if strike > 0 {
				out[strike] = jsonNumber(m["oi_chg"]) / 100000.0
			}
		}
		return out
	}
	ce := parse(chain["ce"])
	pe := parse(chain["pe"])
	points := make([]oiChangePoint, 0, len(scaledStrikes))
	for _, strike := range scaledStrikes {
		points = append(points, oiChangePoint{
			Strike: float64(strike) / 100.0,
			Call:   ce[strike],
			Put:    pe[strike],
		})
	}
	return points, !oiChangeAllZero(points)
}

func (s *server) timeLapseSkew(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"detail": "method not allowed"})
		return
	}
	var req timeLapseSkewRequest
	if err := decodeJSON(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"detail": "invalid JSON"})
		return
	}
	if req.SessionToken == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"detail": "session_token required"})
		return
	}
	if req.DeviceID == "" {
		req.DeviceID = "Nubra-OSS-time-lapse-skew"
	}
	if req.Instrument == "" {
		req.Instrument = "NIFTY"
	}
	if req.Expiry == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"detail": "expiry required"})
		return
	}
	if len(req.Strikes) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"detail": "strikes required"})
		return
	}

	baseTime := time.Now().UTC()
	if req.Time != "" {
		parsed, err := time.Parse(time.RFC3339, req.Time)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"detail": "time must be RFC3339"})
			return
		}
		baseTime = parsed.UTC()
	}
	offsets := req.Offsets
	if len(offsets) == 0 {
		offsets = []int{0, 5, 15, 30, 60}
	}

	exchange := normalizeExchange(req.Exchange)
	scaledStrikes := scaledUniqueStrikes(req.Strikes)
	if len(scaledStrikes) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"detail": "strikes required"})
		return
	}
	atm := req.ATM
	if atm <= 0 {
		atm = float64(scaledStrikes[len(scaledStrikes)/2]) / 100.0
	}

	type querySpec struct {
		key   string
		label string
		when  time.Time
	}
	specs := make([]querySpec, 0, len(offsets)+1)
	seenTimes := map[string]bool{}
	addSpec := func(key, label string, when time.Time) {
		stamp := when.UTC().Format("2006-01-02T15:04:05.000Z")
		if seenTimes[stamp] {
			return
		}
		seenTimes[stamp] = true
		specs = append(specs, querySpec{key: key, label: label, when: when.UTC()})
	}
	for _, minutes := range offsets {
		if minutes < 0 {
			continue
		}
		if minutes == 0 {
			addSpec("now", "Now", baseTime)
			continue
		}
		label := fmt.Sprintf("Last %dm", minutes)
		if minutes >= 60 && minutes%60 == 0 {
			label = fmt.Sprintf("Last %dh", minutes/60)
		}
		addSpec(fmt.Sprintf("last_%dm", minutes), label, baseTime.Add(-time.Duration(minutes)*time.Minute))
	}
	addSpec("yesterday", "Yesterday", baseTime.AddDate(0, 0, -1))
	if len(specs) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"detail": "at least one time offset required"})
		return
	}

	minStrike := scaledStrikes[0]
	maxStrike := scaledStrikes[len(scaledStrikes)-1]
	queryItems := make([]any, 0, len(specs))
	for _, spec := range specs {
		queryItems = append(queryItems, map[string]any{
			"exchange":  exchange,
			"asset":     strings.ToUpper(req.Instrument),
			"expiries":  []string{req.Expiry},
			"minStrike": minStrike,
			"maxStrike": maxStrike,
			"strikes":   scaledStrikes,
			"fields":    []string{"iv_mid"},
			"time":      spec.when.Format("2006-01-02T15:04:05.000Z"),
		})
	}

	payload, status, err := s.nubraJSON(r.Context(), http.MethodPost, nubraBaseURL(req.Environment)+"/charts/multistrike?chart=Time_Lapse_Skew", map[string]string{
		"Authorization": "Bearer " + req.SessionToken,
		"Content-Type":  "application/json",
		"Accept":        "application/json",
		"x-device-id":   req.DeviceID,
	}, map[string]any{"query": queryItems})
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"detail": "Nubra time-lapse skew error: " + err.Error()})
		return
	}
	if status >= 400 {
		writeJSON(w, status, map[string]string{"detail": extractError(payload, status)})
		return
	}

	snapshots := extractIVSnapshots(payload, exchange, strings.ToUpper(req.Instrument), req.Expiry)
	series := make([]timeLapseSkewSeries, 0, len(specs))
	for _, spec := range specs {
		snapshot := snapshots[spec.when.Format(time.RFC3339Nano)]
		if snapshot == nil {
			snapshot = nearestIVSnapshot(snapshots, spec.when)
		}
		points := skewPointsForSnapshot(snapshot, scaledStrikes, atm)
		if len(points) == 0 {
			continue
		}
		series = append(series, timeLapseSkewSeries{
			Key:    spec.key,
			Label:  spec.label,
			Time:   spec.when.Format(time.RFC3339),
			Points: points,
		})
	}
	if len(series) == 0 {
		writeJSON(w, http.StatusBadGateway, map[string]string{"detail": "Nubra time-lapse skew response did not contain IV snapshots"})
		return
	}

	writeJSON(w, http.StatusOK, timeLapseSkewResponse{
		Instrument: strings.ToUpper(req.Instrument),
		Exchange:   exchange,
		Expiry:     req.Expiry,
		ATM:        atm,
		Series:     series,
		Message:    fmt.Sprintf("Loaded time-lapse skew across %d strikes.", len(scaledStrikes)),
	})
}

type oiLegSnapshot struct {
	CE float64
	PE float64
}

func extractOISnapshots(payload map[string]any, exchange, instrument, expiry string) []map[int]oiLegSnapshot {
	result, _ := payload["result"].(map[string]any)
	exchangeNode, _ := result[exchange].(map[string]any)
	instrumentNode, _ := exchangeNode[instrument].(map[string]any)
	if instrumentNode == nil {
		return nil
	}

	type timedSnapshot struct {
		ts   time.Time
		data map[int]oiLegSnapshot
	}
	snapshots := make([]timedSnapshot, 0, len(instrumentNode))
	for timeKey, timeValue := range instrumentNode {
		parsed, err := time.Parse(time.RFC3339Nano, timeKey)
		if err != nil {
			continue
		}
		timeMap, _ := timeValue.(map[string]any)
		expiryMap, _ := timeMap[expiry].(map[string]any)
		if expiryMap == nil {
			continue
		}
		strikeData := map[int]oiLegSnapshot{}
		for strikeKey, strikeValue := range expiryMap {
			strike, err := strconv.Atoi(strikeKey)
			if err != nil {
				continue
			}
			strikeMap, _ := strikeValue.(map[string]any)
			cumulative, _ := strikeMap["cumulative_oi"].(map[string]any)
			if cumulative == nil {
				continue
			}
			strikeData[strike] = oiLegSnapshot{
				CE: jsonNumber(cumulative["CE"]),
				PE: jsonNumber(cumulative["PE"]),
			}
		}
		snapshots = append(snapshots, timedSnapshot{ts: parsed, data: strikeData})
	}

	sort.Slice(snapshots, func(i, j int) bool {
		return snapshots[i].ts.Before(snapshots[j].ts)
	})
	out := make([]map[int]oiLegSnapshot, 0, len(snapshots))
	for _, snapshot := range snapshots {
		out = append(out, snapshot.data)
	}
	return out
}

func scaledUniqueStrikes(strikes []float64) []int {
	out := make([]int, 0, len(strikes))
	seen := map[int]bool{}
	for _, strike := range strikes {
		if strike <= 0 {
			continue
		}
		scaled := int(math.Round(strike * 100))
		if scaled <= 0 || seen[scaled] {
			continue
		}
		out = append(out, scaled)
		seen[scaled] = true
	}
	sort.Ints(out)
	return out
}

func extractIVSnapshots(payload map[string]any, exchange, instrument, expiry string) map[string]map[int]oiLegSnapshot {
	result, _ := payload["result"].(map[string]any)
	exchangeNode, _ := result[exchange].(map[string]any)
	instrumentNode, _ := exchangeNode[instrument].(map[string]any)
	if instrumentNode == nil {
		return nil
	}

	out := map[string]map[int]oiLegSnapshot{}
	for timeKey, timeValue := range instrumentNode {
		parsed, err := time.Parse(time.RFC3339Nano, timeKey)
		if err != nil {
			continue
		}
		timeMap, _ := timeValue.(map[string]any)
		expiryMap, _ := timeMap[expiry].(map[string]any)
		if expiryMap == nil {
			continue
		}
		strikeData := map[int]oiLegSnapshot{}
		for strikeKey, strikeValue := range expiryMap {
			strike, err := strconv.Atoi(strikeKey)
			if err != nil {
				continue
			}
			strikeMap, _ := strikeValue.(map[string]any)
			ivMid, _ := strikeMap["iv_mid"].(map[string]any)
			if ivMid == nil {
				continue
			}
			strikeData[strike] = oiLegSnapshot{
				CE: jsonNumber(ivMid["CE"]),
				PE: jsonNumber(ivMid["PE"]),
			}
		}
		if len(strikeData) > 0 {
			out[parsed.UTC().Format(time.RFC3339Nano)] = strikeData
		}
	}
	return out
}

func nearestIVSnapshot(snapshots map[string]map[int]oiLegSnapshot, target time.Time) map[int]oiLegSnapshot {
	var best map[int]oiLegSnapshot
	bestDelta := time.Duration(1<<63 - 1)
	for key, snapshot := range snapshots {
		parsed, err := time.Parse(time.RFC3339Nano, key)
		if err != nil {
			continue
		}
		delta := parsed.Sub(target)
		if delta < 0 {
			delta = -delta
		}
		if delta < bestDelta {
			bestDelta = delta
			best = snapshot
		}
	}
	return best
}

func skewPointsForSnapshot(snapshot map[int]oiLegSnapshot, scaledStrikes []int, atm float64) []timeLapseSkewPoint {
	if len(snapshot) == 0 {
		return nil
	}
	points := make([]timeLapseSkewPoint, 0, len(scaledStrikes))
	for _, scaled := range scaledStrikes {
		legs := snapshot[scaled]
		callIV := legs.CE * 100.0
		putIV := legs.PE * 100.0
		strike := float64(scaled) / 100.0
		iv := 0.0
		if strike < atm {
			iv = putIV
			if iv <= 0 {
				iv = callIV
			}
		} else if strike > atm {
			iv = callIV
			if iv <= 0 {
				iv = putIV
			}
		} else if callIV > 0 && putIV > 0 {
			iv = (callIV + putIV) / 2.0
		} else {
			iv = math.Max(callIV, putIV)
		}
		if iv <= 0 || math.IsNaN(iv) || math.IsInf(iv, 0) {
			continue
		}
		points = append(points, timeLapseSkewPoint{
			Strike: strike,
			IV:     iv,
			CallIV: callIV,
			PutIV:  putIV,
		})
	}
	return points
}

func jsonNumber(value any) float64 {
	switch typed := value.(type) {
	case float64:
		return typed
	case float32:
		return float64(typed)
	case int:
		return float64(typed)
	case int64:
		return float64(typed)
	case json.Number:
		out, _ := typed.Float64()
		return out
	}
	return 0
}

type rollingStraddleRequest struct {
	SessionToken string  `json:"session_token"`
	DeviceID     string  `json:"device_id"`
	Environment  string  `json:"environment"`
	Exchange     string  `json:"exchange"`
	Instrument   string  `json:"instrument"`
	Expiry       string  `json:"expiry"`
	StartDate    string  `json:"start_date"`
	EndDate      string  `json:"end_date"`
	Interval     string  `json:"interval"`
	Date         string  `json:"date"`
	StrikeCount  int     `json:"strike_count"`
	Mode         string  `json:"mode"`
	CEStrike     float64 `json:"ce_strike"`
	PEStrike     float64 `json:"pe_strike"`
}

type rollingPoint struct {
	Ts    int64   `json:"ts"`
	Value float64 `json:"value"`
}

type straddleSeries struct {
	Strike     float64        `json:"strike"`
	CEStrike   float64        `json:"ce_strike,omitempty"`
	PEStrike   float64        `json:"pe_strike,omitempty"`
	CE         string         `json:"ce"`
	PE         string         `json:"pe"`
	Points     []rollingPoint `json:"points"`
	IVPoints   []rollingPoint `json:"iv_points,omitempty"`
	CEIVPoints []rollingPoint `json:"ce_iv_points,omitempty"`
	PEIVPoints []rollingPoint `json:"pe_iv_points,omitempty"`
}

type rollingStraddleResponse struct {
	Instrument      string           `json:"instrument"`
	Exchange        string           `json:"exchange"`
	Expiry          string           `json:"expiry"`
	Mode            string           `json:"mode"`
	Source          string           `json:"source,omitempty"`
	ATM             float64          `json:"atm"`
	Interval        string           `json:"interval"`
	StrikeCount     int              `json:"strike_count"`
	StartDate       string           `json:"start_date,omitempty"`
	EndDate         string           `json:"end_date,omitempty"`
	Rolling         []rollingPoint   `json:"rolling"`
	RollingIV       []rollingPoint   `json:"rolling_iv"`
	RollingCEIV     []rollingPoint   `json:"rolling_ce_iv"`
	RollingPEIV     []rollingPoint   `json:"rolling_pe_iv"`
	Spot            []rollingPoint   `json:"spot"`
	SyntheticFuture []rollingPoint   `json:"synthetic_future"`
	Straddles       []straddleSeries `json:"straddles"`
	Message         string           `json:"message"`
}

type ivSkewRequest struct {
	SessionToken string `json:"session_token"`
	DeviceID     string `json:"device_id"`
	Environment  string `json:"environment"`
	Exchange     string `json:"exchange"`
	Instrument   string `json:"instrument"`
	Expiry       string `json:"expiry"`
	Interval     string `json:"interval"`
	Date         string `json:"date"`
}

type ivSkewLeg struct {
	Strike float64 `json:"strike"`
	Symbol string  `json:"symbol"`
	RefID  int     `json:"ref_id"`
	IV     float64 `json:"iv"`
	Delta  float64 `json:"delta"`
}

type ivSkewResponse struct {
	Instrument string         `json:"instrument"`
	Exchange   string         `json:"exchange"`
	Expiry     string         `json:"expiry"`
	Interval   string         `json:"interval"`
	CE         ivSkewLeg      `json:"ce"`
	PE         ivSkewLeg      `json:"pe"`
	Ratio      float64        `json:"ratio"`
	Points     []rollingPoint `json:"points"`
	Message    string         `json:"message"`
}

type rollingIVLeg struct {
	Label  string         `json:"label"`
	Strike float64        `json:"strike"`
	Symbol string         `json:"symbol"`
	RefID  int            `json:"ref_id"`
	IV     float64        `json:"iv"`
	Delta  float64        `json:"delta"`
	Points []rollingPoint `json:"points"`
}

type rollingIVResponse struct {
	Instrument   string         `json:"instrument"`
	Exchange     string         `json:"exchange"`
	Expiry       string         `json:"expiry"`
	Interval     string         `json:"interval"`
	ATM          rollingIVLeg   `json:"atm"`
	CE25         rollingIVLeg   `json:"ce_25"`
	PE25         rollingIVLeg   `json:"pe_25"`
	CE10         rollingIVLeg   `json:"ce_10"`
	PE10         rollingIVLeg   `json:"pe_10"`
	Spot         []rollingPoint `json:"spot"`
	CurrentPrice float64        `json:"current_price"`
	Message      string         `json:"message"`
}

type rollingIVCandidate struct {
	Strike     float64
	Symbol     string
	RefID      int
	ChainIV    float64
	ChainDelta float64
	IsCall     bool
	IVByTs     map[int64]float64
}

type optionRef struct {
	RefID  int
	Strike float64
	Symbol string
	IV     float64
	Delta  float64
	LTP    float64
}

func (s *server) growwRollingStraddle(ctx context.Context, req rollingStraddleRequest) (rollingStraddleResponse, bool, error) {
	symbol, ok := growwRollingSymbol(req.Instrument)
	if !ok {
		return rollingStraddleResponse{}, false, nil
	}
	expiry, ok := growwExpiry(req.Expiry)
	if !ok {
		return rollingStraddleResponse{}, true, fmt.Errorf("Groww rolling straddle needs an expiry date")
	}
	interval := growwInterval(req.Interval)
	endDate := growwEndDate(req.EndDate, expiry)
	startDate := ""
	if parsed, ok := growwExpiry(req.StartDate); ok {
		startDate = parsed
	}
	fetchGroww := func(endDate string) (map[string]any, int, error) {
		growwURL := "https://915.groww.in/v1/api/trading-pro/trading-pro-master/v1/chart/straddle/historical/" +
			url.PathEscape(symbol) + "/public?endDate=" + url.QueryEscape(endDate) + "&expiry=" + url.QueryEscape(expiry) +
			"&interval=" + url.QueryEscape(interval) + "&startDate=" + url.QueryEscape(startDate) + "&symbol=" + url.QueryEscape(symbol)
		return s.nubraJSON(ctx, http.MethodGet, growwURL, map[string]string{
			"Accept":     "application/json",
			"User-Agent": "Mozilla/5.0",
		}, nil)
	}

	payload, status, err := fetchGroww(endDate)
	if err == nil && status >= 400 && endDate != "" {
		payload, status, err = fetchGroww("")
	}
	if err != nil {
		return rollingStraddleResponse{}, true, fmt.Errorf("Groww rolling straddle error: %w", err)
	}
	if status >= 400 {
		return rollingStraddleResponse{}, true, fmt.Errorf("Groww rolling straddle failed with status %d", status)
	}

	candles, _ := payload["candles"].([]any)
	if len(candles) == 0 {
		return rollingStraddleResponse{}, true, fmt.Errorf("Groww returned no rolling straddle candles")
	}

	rolling := make([]rollingPoint, 0, len(candles))
	spot := make([]rollingPoint, 0, len(candles))
	synthetic := make([]rollingPoint, 0, len(candles))
	ceIV := make([]rollingPoint, 0, len(candles))
	peIV := make([]rollingPoint, 0, len(candles))
	rollingIV := make([]rollingPoint, 0, len(candles))
	straddlePoints := make([]rollingPoint, 0, len(candles))
	latestStrike := 0.0
	latestCE := 0.0
	latestPE := 0.0

	for _, rawCandle := range candles {
		candle, _ := rawCandle.([]any)
		if len(candle) < 5 {
			continue
		}
		tsSeconds := anyInt64(candle[0])
		closeSnap := growwSnapshotValues(candle[4])
		if tsSeconds <= 0 || len(closeSnap) < 5 {
			continue
		}
		ts := tsSeconds * int64(time.Second)
		cePrice := anyFloat(closeSnap[0])
		pePrice := anyFloat(closeSnap[1])
		strike := anyFloat(closeSnap[2])
		spotPrice := anyFloat(closeSnap[3])
		syntheticFuture := anyFloat(closeSnap[4])
		premium := cePrice + pePrice
		if premium <= 0 && len(candle) > 5 {
			premium = anyFloat(candle[5])
		}
		if premium <= 0 {
			continue
		}

		point := rollingPoint{Ts: ts, Value: premium}
		rolling = append(rolling, point)
		straddlePoints = append(straddlePoints, point)
		if spotPrice > 0 {
			spot = append(spot, rollingPoint{Ts: ts, Value: spotPrice})
		}
		if syntheticFuture > 0 {
			synthetic = append(synthetic, rollingPoint{Ts: ts, Value: syntheticFuture})
		}
		years := yearsToExpiryDate(ts, expiry)
		ceVol, ceOK := impliedVolatility(cePrice, spotPrice, strike, years, 0.06, true)
		peVol, peOK := impliedVolatility(pePrice, spotPrice, strike, years, 0.06, false)
		if ceOK {
			ceIV = append(ceIV, rollingPoint{Ts: ts, Value: ceVol * 100.0})
		}
		if peOK {
			peIV = append(peIV, rollingPoint{Ts: ts, Value: peVol * 100.0})
		}
		if ceOK && peOK {
			rollingIV = append(rollingIV, rollingPoint{Ts: ts, Value: (ceVol + peVol) * 50.0})
		}
		if strike > 0 {
			latestStrike = strike
		}
		if cePrice > 0 {
			latestCE = cePrice
		}
		if pePrice > 0 {
			latestPE = pePrice
		}
	}
	if len(rolling) == 0 {
		return rollingStraddleResponse{}, true, fmt.Errorf("Groww rolling straddle candles could not be parsed")
	}

	straddles := []straddleSeries{{
		Strike:     latestStrike,
		CEStrike:   latestStrike,
		PEStrike:   latestStrike,
		CE:         fmt.Sprintf("%s %.0f CE", symbol, latestStrike),
		PE:         fmt.Sprintf("%s %.0f PE", symbol, latestStrike),
		Points:     straddlePoints,
		IVPoints:   rollingIV,
		CEIVPoints: ceIV,
		PEIVPoints: peIV,
	}}
	message := fmt.Sprintf("Loaded Groww public rolling straddle for %s. CE/PE IV is derived from the selected strike prices, spot, and expiry.", symbol)
	if latestCE > 0 && latestPE > 0 && latestStrike > 0 {
		message = fmt.Sprintf("%s Latest selected strike %.0f uses CE %.2f and PE %.2f.", message, latestStrike, latestCE, latestPE)
	}

	ist := time.FixedZone("IST", 5*3600+30*60)
	tsToDate := func(tsNano int64) string {
		return time.Unix(0, tsNano).In(ist).Format("2006-01-02")
	}
	firstDate, lastDate := "", ""
	if len(rolling) > 0 {
		firstDate = tsToDate(rolling[0].Ts)
		lastDate = tsToDate(rolling[len(rolling)-1].Ts)
	}

	return rollingStraddleResponse{
		Instrument:      symbol,
		Exchange:        growwExchange(symbol),
		Expiry:          strings.ReplaceAll(expiry, "-", ""),
		Mode:            "rolling",
		Source:          "groww",
		ATM:             latestStrike,
		Interval:        req.Interval,
		StrikeCount:     len(straddles),
		StartDate:       firstDate,
		EndDate:         lastDate,
		Rolling:         rolling,
		RollingIV:       rollingIV,
		RollingCEIV:     ceIV,
		RollingPEIV:     peIV,
		Spot:            spot,
		SyntheticFuture: synthetic,
		Straddles:       straddles,
		Message:         message,
	}, true, nil
}

func growwSnapshotValues(value any) []any {
	if arr, ok := value.([]any); ok {
		return arr
	}
	m, _ := value.(map[string]any)
	if arr, ok := m["value"].([]any); ok {
		return arr
	}
	return nil
}

func growwRollingSymbol(instrument string) (string, bool) {
	switch strings.ToUpper(strings.TrimSpace(instrument)) {
	case "NIFTY", "NIFTY50":
		return "NIFTY", true
	case "SENSEX":
		return "SENSEX", true
	default:
		return "", false
	}
}

func growwExchange(symbol string) string {
	if symbol == "SENSEX" {
		return "BSE"
	}
	return "NSE"
}

func growwExpiry(expiry string) (string, bool) {
	expiry = strings.TrimSpace(expiry)
	if parsed, ok := parseCompactDate(expiry); ok {
		return parsed, true
	}
	if regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`).MatchString(expiry) {
		return expiry, true
	}
	return "", false
}

func growwEndDate(endDate, expiry string) string {
	if parsed, ok := growwExpiry(endDate); ok {
		return parsed
	}
	// Use yesterday in IST so Groww doesn't 500 on a future/today date.
	// If expiry is in the past, use expiry instead (handles historical expiries).
	ist := time.FixedZone("IST", 5*3600+30*60)
	yesterday := time.Now().In(ist).AddDate(0, 0, -1).Format("2006-01-02")
	if parsed, ok := growwExpiry(expiry); ok {
		exp, err := time.ParseInLocation("2006-01-02", parsed, ist)
		if err == nil && exp.Before(time.Now().In(ist)) {
			return parsed
		}
	}
	return yesterday
}

func marketSessionWindow(date string) (string, string) {
	ist := time.FixedZone("IST", 5*3600+30*60)
	nowIST := time.Now().In(ist)
	sessionDate := nowIST.Format("2006-01-02")
	if parsed, ok := parseCompactDate(date); ok {
		sessionDate = parsed
	} else if regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`).MatchString(strings.TrimSpace(date)) {
		sessionDate = strings.TrimSpace(date)
	}
	startIST, _ := time.ParseInLocation("2006-01-02 15:04", sessionDate+" 09:15", ist)
	closeIST, _ := time.ParseInLocation("2006-01-02 15:04", sessionDate+" 15:30", ist)
	endIST := nowIST
	if sessionDate != nowIST.Format("2006-01-02") || nowIST.After(closeIST) {
		endIST = closeIST
	}
	if endIST.Before(startIST) {
		endIST = startIST.Add(5 * time.Minute)
	}
	return startIST.UTC().Format("2006-01-02T15:04:05.000Z"), endIST.UTC().Format("2006-01-02T15:04:05.000Z")
}

func growwInterval(interval string) string {
	switch interval {
	case "3m":
		return "3"
	case "5m":
		return "5"
	case "15m":
		return "15"
	case "30m":
		return "30"
	default:
		return "1"
	}
}

func (s *server) rollingStraddle(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"detail": "method not allowed"})
		return
	}
	var req rollingStraddleRequest
	if err := decodeJSON(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"detail": "invalid JSON"})
		return
	}
	if req.DeviceID == "" {
		req.DeviceID = "Nubra-OSS-straddle"
	}
	if req.Instrument == "" {
		req.Instrument = "NIFTY"
	}
	if req.Interval == "" {
		req.Interval = "5m"
	}
	if req.StrikeCount <= 0 {
		req.StrikeCount = 11
	}
	customMode := strings.EqualFold(req.Mode, "custom") || req.CEStrike > 0 || req.PEStrike > 0
	if !customMode {
		growwResponse, supported, err := s.growwRollingStraddle(r.Context(), req)
		if supported {
			if err == nil {
				writeJSON(w, http.StatusOK, growwResponse)
				return
			}
			if req.SessionToken == "" {
				writeJSON(w, http.StatusBadGateway, map[string]string{"detail": err.Error()})
				return
			}
		}
	}
	if req.SessionToken == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"detail": "session_token required"})
		return
	}

	baseURL := nubraBaseURL(req.Environment)
	exchange := normalizeExchange(req.Exchange)
	start, end := marketSessionWindow(req.Date)
	headers := map[string]string{
		"Authorization": "Bearer " + req.SessionToken,
		"Accept":        "application/json",
		"x-device-id":   req.DeviceID,
	}
	chainURL := baseURL + "/optionchains/" + url.PathEscape(req.Instrument) + "?exchange=" + url.QueryEscape(exchange)
	if req.Expiry != "" {
		chainURL += "&expiry=" + url.QueryEscape(req.Expiry)
	}
	chainPayload, status, err := s.nubraJSON(r.Context(), http.MethodGet, chainURL, headers, nil)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"detail": "Nubra option chain error: " + err.Error()})
		return
	}
	if status >= 400 {
		writeJSON(w, status, map[string]string{"detail": extractError(chainPayload, status)})
		return
	}
	chain, _ := chainPayload["chain"].(map[string]any)
	if chain == nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"detail": "unexpected option chain response"})
		return
	}

	atm := anyFloat(chain["atm"])
	expiry, _ := chain["expiry"].(string)
	if expiry == "" {
		expiry = req.Expiry
	}
	ceByStrike := optionRefsByStrike(chain["ce"])
	peByStrike := optionRefsByStrike(chain["pe"])
	allStrikes := sharedStrikes(ceByStrike, peByStrike)
	if len(allStrikes) == 0 {
		writeJSON(w, http.StatusBadGateway, map[string]string{"detail": "no matching CE/PE strikes found"})
		return
	}

	underlying, underlyingErr := s.underlyingSeries(r.Context(), baseURL, req.SessionToken, req.DeviceID, exchange, req.Instrument, req.Interval, start, end)
	strikeWings := req.StrikeCount / 2
	strikes := strikesForUnderlyingBand(allStrikes, underlying, atm, strikeWings)
	if len(strikes) == 0 {
		strikes = strikesAroundValue(allStrikes, atm, strikeWings)
	}
	if len(strikes) > req.StrikeCount {
		strikes = nearestStrikeCount(strikes, latestStrikeAnchor(underlying, atm), req.StrikeCount)
	}
	if customMode {
		if req.CEStrike <= 0 || req.PEStrike <= 0 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"detail": "ce_strike and pe_strike are required for custom mode"})
			return
		}
		ceStrike := normalizeStrikeInput(req.CEStrike)
		peStrike := normalizeStrikeInput(req.PEStrike)
		if _, ok := ceByStrike[ceStrike]; !ok {
			writeJSON(w, http.StatusBadRequest, map[string]string{"detail": fmt.Sprintf("CE strike %.2f was not found for %s %s", ceStrike/100.0, req.Instrument, expiry)})
			return
		}
		if _, ok := peByStrike[peStrike]; !ok {
			writeJSON(w, http.StatusBadRequest, map[string]string{"detail": fmt.Sprintf("PE strike %.2f was not found for %s %s", peStrike/100.0, req.Instrument, expiry)})
			return
		}
		strikes = []float64{ceStrike, peStrike}
	}

	refDate := req.Date
	if refDate == "" {
		refDate = time.Now().In(time.FixedZone("IST", 5*3600+30*60)).Format("2006-01-02")
	}
	requiredRefs := optionRefIDsForStrikes(strikes, customMode, ceByStrike, peByStrike)
	refMap, err := s.refSymbolsByIDForRefs(r.Context(), baseURL, req.SessionToken, req.DeviceID, exchange, refDateCandidates(refDate, expiry), requiredRefs)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"detail": err.Error()})
		return
	}

	symbolSet := map[string]bool{}
	if customMode {
		ce := ceByStrike[strikes[0]]
		pe := peByStrike[strikes[1]]
		ce.Symbol = strings.ToUpper(refMap[ce.RefID])
		pe.Symbol = strings.ToUpper(refMap[pe.RefID])
		ceByStrike[strikes[0]] = ce
		peByStrike[strikes[1]] = pe
		if ce.Symbol != "" {
			symbolSet[ce.Symbol] = true
		}
		if pe.Symbol != "" {
			symbolSet[pe.Symbol] = true
		}
	} else {
		for _, strike := range strikes {
			ce := ceByStrike[strike]
			pe := peByStrike[strike]
			ce.Symbol = strings.ToUpper(refMap[ce.RefID])
			pe.Symbol = strings.ToUpper(refMap[pe.RefID])
			ceByStrike[strike] = ce
			peByStrike[strike] = pe
			if ce.Symbol != "" {
				symbolSet[ce.Symbol] = true
			}
			if pe.Symbol != "" {
				symbolSet[pe.Symbol] = true
			}
		}
	}
	symbols := make([]string, 0, len(symbolSet))
	for symbol := range symbolSet {
		symbols = append(symbols, symbol)
	}
	sort.Strings(symbols)
	if len(symbols) == 0 {
		writeJSON(w, http.StatusBadGateway, map[string]string{"detail": "selected option ref_ids were not found in refdata"})
		return
	}

	candles := map[string][]rollingPoint{}
	ivCandles := map[string][]rollingPoint{}
	ivFallbackUsed := false
	for i := 0; i < len(symbols); i += 8 {
		endIdx := i + 8
		if endIdx > len(symbols) {
			endIdx = len(symbols)
		}
		body := map[string]any{
			"query": []any{map[string]any{
				"exchange":  exchange,
				"type":      "OPT",
				"values":    symbols[i:endIdx],
				"fields":    []string{"close", "iv"},
				"startDate": start,
				"endDate":   end,
				"interval":  req.Interval,
				"intraDay":  false,
				"realTime":  false,
			}},
		}
		payload, st, callErr := s.nubraJSON(r.Context(), http.MethodPost, baseURL+"/charts/timeseries",
			map[string]string{
				"Authorization": "Bearer " + req.SessionToken,
				"Content-Type":  "application/json",
				"Accept":        "application/json",
				"x-device-id":   req.DeviceID,
			}, body)
		if callErr != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"detail": "Nubra timeseries error: " + callErr.Error()})
			return
		}
		if st >= 400 {
			detail := extractError(payload, st)
			if strings.Contains(strings.ToLower(detail), "iv") {
				ivFallbackUsed = true
				body["query"].([]any)[0].(map[string]any)["fields"] = []string{"close"}
				payload, st, callErr = s.nubraJSON(r.Context(), http.MethodPost, baseURL+"/charts/timeseries",
					map[string]string{
						"Authorization": "Bearer " + req.SessionToken,
						"Content-Type":  "application/json",
						"Accept":        "application/json",
						"x-device-id":   req.DeviceID,
					}, body)
				if callErr != nil {
					writeJSON(w, http.StatusBadGateway, map[string]string{"detail": "Nubra timeseries error: " + callErr.Error()})
					return
				}
				if st >= 400 {
					writeJSON(w, st, map[string]string{"detail": extractError(payload, st)})
					return
				}
			} else {
				writeJSON(w, st, map[string]string{"detail": detail})
				return
			}
		}
		for symbol, points := range closeSeries(payload) {
			candles[symbol] = points
		}
		for symbol, points := range fieldSeries(payload, "iv") {
			ivCandles[symbol] = points
		}
	}

	if customMode {
		ceStrike := strikes[0]
		peStrike := strikes[1]
		ce := ceByStrike[ceStrike]
		pe := peByStrike[peStrike]
		points := sumSeries(candles[ce.Symbol], candles[pe.Symbol])
		ceIV := optionIVSeries(candles[ce.Symbol], ivCandles[ce.Symbol], underlying, ceStrike/100.0, expiry, true)
		peIV := optionIVSeries(candles[pe.Symbol], ivCandles[pe.Symbol], underlying, peStrike/100.0, expiry, false)
		ivPoints := averageSeries(ceIV, peIV)
		customStrikeLabel := ceStrike / 100.0
		if ceStrike != peStrike {
			customStrikeLabel = 0
		}
		straddles := []straddleSeries{{
			Strike:     customStrikeLabel,
			CEStrike:   ceStrike / 100.0,
			PEStrike:   peStrike / 100.0,
			CE:         ce.Symbol,
			PE:         pe.Symbol,
			Points:     points,
			IVPoints:   ivPoints,
			CEIVPoints: ceIV,
			PEIVPoints: peIV,
		}}
		writeJSON(w, http.StatusOK, rollingStraddleResponse{
			Instrument:      req.Instrument,
			Exchange:        exchange,
			Expiry:          expiry,
			Mode:            "custom",
			Source:          "nubra",
			ATM:             atm / 100.0,
			Interval:        req.Interval,
			StrikeCount:     len(straddles),
			Rolling:         points,
			RollingIV:       ivPoints,
			RollingCEIV:     ceIV,
			RollingPEIV:     peIV,
			Spot:            underlying,
			SyntheticFuture: nil,
			Straddles:       straddles,
			Message:         rollingIVMessage(fmt.Sprintf("Loaded custom CE %.2f + PE %.2f premium.", ceStrike/100.0, peStrike/100.0), ivFallbackUsed),
		})
		return
	}

	straddles := make([]straddleSeries, 0, len(strikes))
	for _, strike := range strikes {
		ce := ceByStrike[strike]
		pe := peByStrike[strike]
		points := sumSeries(candles[ce.Symbol], candles[pe.Symbol])
		ceIV := optionIVSeries(candles[ce.Symbol], ivCandles[ce.Symbol], underlying, strike/100.0, expiry, true)
		peIV := optionIVSeries(candles[pe.Symbol], ivCandles[pe.Symbol], underlying, strike/100.0, expiry, false)
		straddles = append(straddles, straddleSeries{
			Strike:     strike / 100.0,
			CEStrike:   strike / 100.0,
			PEStrike:   strike / 100.0,
			CE:         ce.Symbol,
			PE:         pe.Symbol,
			Points:     points,
			IVPoints:   averageSeries(ceIV, peIV),
			CEIVPoints: ceIV,
			PEIVPoints: peIV,
		})
	}
	rolling := rollingByTimestampATM(straddles, underlying, atm/100.0, 5)
	if len(rolling) == 0 {
		rolling = rollingByLowestPremium(straddles)
	}
	rollingIV, rollingCEIV, rollingPEIV := rollingIVByTimestampATM(straddles, underlying, atm/100.0, 5)
	if len(rollingIV) == 0 {
		rollingIV = rollingByLowestIV(straddles)
	}
	writeJSON(w, http.StatusOK, rollingStraddleResponse{
		Instrument:      req.Instrument,
		Exchange:        exchange,
		Expiry:          expiry,
		Mode:            "rolling",
		Source:          "nubra",
		ATM:             atm / 100.0,
		Interval:        req.Interval,
		StrikeCount:     len(straddles),
		Rolling:         rolling,
		RollingIV:       rollingIV,
		RollingCEIV:     rollingCEIV,
		RollingPEIV:     rollingPEIV,
		Spot:            underlying,
		SyntheticFuture: syntheticFutureSeries(strikes, ceByStrike, peByStrike, candles, underlying, atm),
		Straddles:       straddles,
		Message:         rollingIVMessage(rollingStraddleMessage(len(straddles), underlyingErr), ivFallbackUsed),
	})
}

func (s *server) rollingIV(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"detail": "method not allowed"})
		return
	}
	var req ivSkewRequest
	if err := decodeJSON(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"detail": "invalid JSON"})
		return
	}
	if req.SessionToken == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"detail": "session_token required"})
		return
	}
	if req.DeviceID == "" {
		req.DeviceID = "Nubra-OSS-rolling-iv"
	}
	if req.Instrument == "" {
		req.Instrument = "NIFTY"
	}
	if req.Interval == "" {
		req.Interval = "5m"
	}

	baseURL := nubraBaseURL(req.Environment)
	exchange := normalizeExchange(req.Exchange)
	now := time.Now().UTC()
	start := now.AddDate(0, 0, -5).Format("2006-01-02") + "T03:30:00.000Z"
	end := now.Format("2006-01-02T15:04:05.000Z")
	headers := map[string]string{
		"Authorization": "Bearer " + req.SessionToken,
		"Accept":        "application/json",
		"x-device-id":   req.DeviceID,
	}
	chainURL := baseURL + "/optionchains/" + url.PathEscape(req.Instrument) + "?exchange=" + url.QueryEscape(exchange)
	if req.Expiry != "" {
		chainURL += "&expiry=" + url.QueryEscape(req.Expiry)
	}
	chainPayload, status, err := s.nubraJSON(r.Context(), http.MethodGet, chainURL, headers, nil)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"detail": "Nubra option chain error: " + err.Error()})
		return
	}
	if status >= 400 {
		writeJSON(w, status, map[string]string{"detail": extractError(chainPayload, status)})
		return
	}
	chain, _ := chainPayload["chain"].(map[string]any)
	if chain == nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"detail": "unexpected option chain response"})
		return
	}

	atm := anyFloat(chain["atm"])
	currentPrice := anyFloat(chain["cp"])
	if currentPrice <= 0 {
		currentPrice = atm
	}
	expiry, _ := chain["expiry"].(string)
	if expiry == "" {
		expiry = req.Expiry
	}
	ceByStrike := optionRefsByStrike(chain["ce"])
	peByStrike := optionRefsByStrike(chain["pe"])
	allStrikes := sharedStrikes(ceByStrike, peByStrike)
	if len(allStrikes) == 0 {
		writeJSON(w, http.StatusBadGateway, map[string]string{"detail": "no matching CE/PE strikes found"})
		return
	}

	underlying, underlyingErr := s.underlyingSeries(r.Context(), baseURL, req.SessionToken, req.DeviceID, exchange, req.Instrument, req.Interval, start, end)
	underlyingFallbackUsed := false
	if underlyingErr != nil || len(underlying) == 0 {
		spot := currentPrice / 100.0
		if spot <= 0 {
			spot = atm / 100.0
		}
		if spot > 0 {
			underlying = []rollingPoint{{Ts: time.Now().UnixNano(), Value: spot}}
			underlyingFallbackUsed = true
		}
	}
	if len(underlying) == 0 {
		writeJSON(w, http.StatusBadGateway, map[string]string{"detail": "no underlying spot history found for timestamp-wise rolling IV"})
		return
	}

	strikes := rollingIVTargetStrikes(allStrikes, atm, ceByStrike, peByStrike)
	if len(strikes) == 0 {
		strikes = strikesAroundValue(allStrikes, atm, 8)
	}
	refDate := req.Date
	if refDate == "" {
		refDate = time.Now().In(time.FixedZone("IST", 5*3600+30*60)).Format("2006-01-02")
	}
	requiredRefs := optionRefIDsForStrikes(strikes, false, ceByStrike, peByStrike)
	refMap, err := s.refSymbolsByIDForRefs(r.Context(), baseURL, req.SessionToken, req.DeviceID, exchange, refDateCandidates(refDate, expiry), requiredRefs)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"detail": err.Error()})
		return
	}

	symbolSet := map[string]bool{}
	for _, strike := range strikes {
		ce := ceByStrike[strike]
		pe := peByStrike[strike]
		ce.Symbol = strings.ToUpper(refMap[ce.RefID])
		pe.Symbol = strings.ToUpper(refMap[pe.RefID])
		ceByStrike[strike] = ce
		peByStrike[strike] = pe
		if ce.Symbol != "" {
			symbolSet[ce.Symbol] = true
		}
		if pe.Symbol != "" {
			symbolSet[pe.Symbol] = true
		}
	}
	symbols := make([]string, 0, len(symbolSet))
	for symbol := range symbolSet {
		symbols = append(symbols, symbol)
	}
	sort.Strings(symbols)
	if len(symbols) == 0 {
		writeJSON(w, http.StatusBadGateway, map[string]string{"detail": "selected option ref_ids were not found in refdata"})
		return
	}

	candles := map[string][]rollingPoint{}
	ivCandles := map[string][]rollingPoint{}
	ivFallbackUsed := false
	for i := 0; i < len(symbols); i += 8 {
		endIdx := i + 8
		if endIdx > len(symbols) {
			endIdx = len(symbols)
		}
		body := map[string]any{
			"query": []any{map[string]any{
				"exchange":  exchange,
				"type":      "OPT",
				"values":    symbols[i:endIdx],
				"fields":    []string{"close", "iv"},
				"startDate": start,
				"endDate":   end,
				"interval":  req.Interval,
				"intraDay":  false,
				"realTime":  false,
			}},
		}
		payload, st, callErr := s.nubraJSON(r.Context(), http.MethodPost, baseURL+"/charts/timeseries",
			map[string]string{
				"Authorization": "Bearer " + req.SessionToken,
				"Content-Type":  "application/json",
				"Accept":        "application/json",
				"x-device-id":   req.DeviceID,
			}, body)
		if callErr != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"detail": "Nubra timeseries error: " + callErr.Error()})
			return
		}
		if st >= 400 {
			detail := extractError(payload, st)
			if strings.Contains(strings.ToLower(detail), "iv") {
				ivFallbackUsed = true
				body["query"].([]any)[0].(map[string]any)["fields"] = []string{"close"}
				payload, st, callErr = s.nubraJSON(r.Context(), http.MethodPost, baseURL+"/charts/timeseries",
					map[string]string{
						"Authorization": "Bearer " + req.SessionToken,
						"Content-Type":  "application/json",
						"Accept":        "application/json",
						"x-device-id":   req.DeviceID,
					}, body)
				if callErr != nil {
					writeJSON(w, http.StatusBadGateway, map[string]string{"detail": "Nubra timeseries error: " + callErr.Error()})
					return
				}
				if st >= 400 {
					writeJSON(w, st, map[string]string{"detail": extractError(payload, st)})
					return
				}
			} else {
				writeJSON(w, st, map[string]string{"detail": detail})
				return
			}
		}
		for symbol, points := range closeSeries(payload) {
			candles[symbol] = points
		}
		for symbol, points := range fieldSeries(payload, "iv") {
			ivCandles[symbol] = points
		}
	}

	priceBasis := syntheticFutureSeries(strikes, ceByStrike, peByStrike, candles, underlying, atm)
	syntheticBasisUsed := len(priceBasis) > 0
	if !syntheticBasisUsed {
		priceBasis = underlying
	}

	ceCandidates := make([]rollingIVCandidate, 0, len(strikes))
	peCandidates := make([]rollingIVCandidate, 0, len(strikes))
	for _, strike := range strikes {
		ce := ceByStrike[strike]
		if ce.Symbol != "" {
			ivPoints := optionIVSeries(candles[ce.Symbol], ivCandles[ce.Symbol], priceBasis, strike/100.0, expiry, true)
			ceCandidates = append(ceCandidates, rollingIVCandidate{
				Strike: strike, Symbol: ce.Symbol, RefID: ce.RefID, ChainIV: ce.IV, ChainDelta: ce.Delta, IsCall: true, IVByTs: pointsByTs(ivPoints),
			})
		}
		pe := peByStrike[strike]
		if pe.Symbol != "" {
			ivPoints := optionIVSeries(candles[pe.Symbol], ivCandles[pe.Symbol], priceBasis, strike/100.0, expiry, false)
			peCandidates = append(peCandidates, rollingIVCandidate{
				Strike: strike, Symbol: pe.Symbol, RefID: pe.RefID, ChainIV: pe.IV, ChainDelta: pe.Delta, IsCall: false, IVByTs: pointsByTs(ivPoints),
			})
		}
	}

	atmLeg := rollingATMIVLeg("ATM IV", priceBasis, strikes, ceCandidates, peCandidates)
	ce25 := rollingDeltaIVLeg("25D Call IV", 0.25, priceBasis, ceCandidates, expiry)
	pe25 := rollingDeltaIVLeg("25D Put IV", -0.25, priceBasis, peCandidates, expiry)
	ce10 := rollingDeltaIVLeg("10D Call IV", 0.10, priceBasis, ceCandidates, expiry)
	pe10 := rollingDeltaIVLeg("10D Put IV", -0.10, priceBasis, peCandidates, expiry)

	message := "Loaded timestamp-wise Rolling IV. Each candle reselects ATM, 25D call/put, and 10D call/put from rolling synthetic future and Nubra REST IV."
	if !syntheticBasisUsed {
		message += " Synthetic future was unavailable, so raw underlying spot was used."
	}
	if ivFallbackUsed {
		message += " Nubra REST IV was unavailable for at least one batch, so IV was computed from option prices only for that missing batch."
	}
	if underlyingFallbackUsed {
		message += " Underlying history was unavailable, so current spot was used as a fast fallback."
	}
	writeJSON(w, http.StatusOK, rollingIVResponse{
		Instrument:   req.Instrument,
		Exchange:     exchange,
		Expiry:       expiry,
		Interval:     req.Interval,
		ATM:          atmLeg,
		CE25:         ce25,
		PE25:         pe25,
		CE10:         ce10,
		PE10:         pe10,
		Spot:         underlying,
		CurrentPrice: currentPrice / 100.0,
		Message:      message,
	})
}

func (s *server) ivSkew(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"detail": "method not allowed"})
		return
	}
	var req ivSkewRequest
	if err := decodeJSON(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"detail": "invalid JSON"})
		return
	}
	if req.SessionToken == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"detail": "session_token required"})
		return
	}
	if req.DeviceID == "" {
		req.DeviceID = "Nubra-OSS-iv-skew"
	}
	if req.Instrument == "" {
		req.Instrument = "NIFTY"
	}
	if req.Interval == "" {
		req.Interval = "5m"
	}

	baseURL := nubraBaseURL(req.Environment)
	exchange := normalizeExchange(req.Exchange)
	now := time.Now().UTC()
	start := now.AddDate(0, 0, -5).Format("2006-01-02") + "T03:30:00.000Z"
	end := now.Format("2006-01-02T15:04:05.000Z")
	headers := map[string]string{
		"Authorization": "Bearer " + req.SessionToken,
		"Accept":        "application/json",
		"x-device-id":   req.DeviceID,
	}
	chainURL := baseURL + "/optionchains/" + url.PathEscape(req.Instrument) + "?exchange=" + url.QueryEscape(exchange)
	if req.Expiry != "" {
		chainURL += "&expiry=" + url.QueryEscape(req.Expiry)
	}
	chainPayload, status, err := s.nubraJSON(r.Context(), http.MethodGet, chainURL, headers, nil)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"detail": "Nubra option chain error: " + err.Error()})
		return
	}
	if status >= 400 {
		writeJSON(w, status, map[string]string{"detail": extractError(chainPayload, status)})
		return
	}
	chain, _ := chainPayload["chain"].(map[string]any)
	if chain == nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"detail": "unexpected option chain response"})
		return
	}
	atm := anyFloat(chain["atm"])
	currentPrice := anyFloat(chain["cp"])
	if currentPrice <= 0 {
		currentPrice = atm
	}
	expiry, _ := chain["expiry"].(string)
	if expiry == "" {
		expiry = req.Expiry
	}
	ceByStrike := optionRefsByStrike(chain["ce"])
	peByStrike := optionRefsByStrike(chain["pe"])
	ce, ok := closestDeltaOption(ceByStrike, 0.10)
	if !ok {
		writeJSON(w, http.StatusBadGateway, map[string]string{"detail": "no usable 0.10 delta call found"})
		return
	}
	pe, ok := closestDeltaOption(peByStrike, -0.10)
	if !ok {
		writeJSON(w, http.StatusBadGateway, map[string]string{"detail": "no usable 0.10 delta put found"})
		return
	}

	underlying, underlyingErr := s.underlyingSeries(r.Context(), baseURL, req.SessionToken, req.DeviceID, exchange, req.Instrument, req.Interval, start, end)
	if underlyingErr != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"detail": "Nubra underlying history error: " + underlyingErr.Error()})
		return
	}
	points := ivSkewByTimestampSpot(underlying, ceByStrike, peByStrike, currentPrice, ce.Strike, pe.Strike)
	if len(points) == 0 {
		writeJSON(w, http.StatusBadGateway, map[string]string{"detail": "unable to build IV skew from spot history and option-chain IV curve"})
		return
	}

	refDate := req.Date
	if refDate == "" {
		refDate = time.Now().In(time.FixedZone("IST", 5*3600+30*60)).Format("2006-01-02")
	}
	refMap, err := s.refSymbolsByIDForRefs(r.Context(), baseURL, req.SessionToken, req.DeviceID, exchange, refDateCandidates(refDate, expiry), []int{ce.RefID, pe.RefID})
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"detail": err.Error()})
		return
	}
	ce.Symbol = strings.ToUpper(refMap[ce.RefID])
	pe.Symbol = strings.ToUpper(refMap[pe.RefID])
	writeJSON(w, http.StatusOK, ivSkewResponse{
		Instrument: req.Instrument,
		Exchange:   exchange,
		Expiry:     expiry,
		Interval:   req.Interval,
		CE:         ivSkewLeg{Strike: ce.Strike / 100.0, Symbol: ce.Symbol, RefID: ce.RefID, IV: ce.IV, Delta: ce.Delta},
		PE:         ivSkewLeg{Strike: pe.Strike / 100.0, Symbol: pe.Symbol, RefID: pe.RefID, IV: pe.IV, Delta: pe.Delta},
		Ratio:      ce.IV / pe.IV,
		Points:     points,
		Message:    fmt.Sprintf("Loaded 5-day spot-adjusted IV skew. Current 10-delta anchors are CE %.2f delta %.2f and PE %.2f delta %.2f.", ce.Strike/100.0, ce.Delta, pe.Strike/100.0, pe.Delta),
	})
}

// ── WEEKLY VIX ───────────────────────────────────────────────────────────────

type weeklyVixRequest struct {
	SessionToken string `json:"session_token"`
	DeviceID     string `json:"device_id"`
	Environment  string `json:"environment"`
	Exchange     string `json:"exchange"`
	Instrument   string `json:"instrument"`
	Interval     string `json:"interval"`
	EndDate      string `json:"end_date"`
}

type weeklyVixResponse struct {
	Instrument string         `json:"instrument"`
	Exchange   string         `json:"exchange"`
	Points     []rollingPoint `json:"points"`
	Latest     float64        `json:"latest"`
	Message    string         `json:"message"`
}

// growwVixVariance fetches Groww candles for one expiry and returns a map of
// tsNano → variance contribution at that timestamp.
func (s *server) growwVixVariance(ctx context.Context, symbol, expiry, endDate, interval string) map[int64]float64 {
	gInterval := growwInterval(interval)
	// Groww requires an explicit startDate or it 500s — use 7 days before endDate
	startDate := ""
	if ed, ok := growwExpiry(endDate); ok {
		ist := time.FixedZone("IST", 5*3600+30*60)
		if t, err := time.ParseInLocation("2006-01-02", ed, ist); err == nil {
			startDate = t.AddDate(0, 0, -7).Format("2006-01-02")
		}
	}
	growwURL := "https://915.groww.in/v1/api/trading-pro/trading-pro-master/v1/chart/straddle/historical/" +
		url.PathEscape(symbol) + "/public?endDate=" + url.QueryEscape(endDate) + "&expiry=" + url.QueryEscape(expiry) +
		"&interval=" + url.QueryEscape(gInterval) + "&startDate=" + url.QueryEscape(startDate) + "&symbol=" + url.QueryEscape(symbol)
	payload, status, err := s.nubraJSON(ctx, http.MethodGet, growwURL, map[string]string{
		"Accept":     "application/json",
		"User-Agent": "Mozilla/5.0",
	}, nil)
	if err != nil || status >= 400 {
		return nil
	}
	candles, _ := payload["candles"].([]any)
	result := make(map[int64]float64, len(candles))
	for _, rawCandle := range candles {
		candle, _ := rawCandle.([]any)
		if len(candle) < 5 {
			continue
		}
		tsSeconds := anyInt64(candle[0])
		closeSnap := growwSnapshotValues(candle[4])
		if tsSeconds <= 0 || len(closeSnap) < 4 {
			continue
		}
		tsNano := tsSeconds * int64(time.Second)
		cePrice := anyFloat(closeSnap[0])
		pePrice := anyFloat(closeSnap[1])
		strike := anyFloat(closeSnap[2])
		spotPrice := anyFloat(closeSnap[3])
		if cePrice <= 0 || pePrice <= 0 || strike <= 0 || spotPrice <= 0 {
			continue
		}
		years := yearsToExpiryDate(tsNano, expiry)
		if years <= 0 {
			continue
		}
		ceIV, ceOK := impliedVolatility(cePrice, spotPrice, strike, years, 0.06, true)
		peIV, peOK := impliedVolatility(pePrice, spotPrice, strike, years, 0.06, false)
		if !ceOK || !peOK {
			continue
		}
		avgIV := (ceIV + peIV) / 2.0
		// variance = σ² × T  (the raw input to VIX interpolation)
		result[tsNano] = avgIV * avgIV * years
	}
	return result
}

// vixStrikeData holds the option price (bid/ask mid or LTP) for one strike used in CBOE summation.
type vixStrikeData struct {
	strike float64 // raw units (e.g. 2495000 for NIFTY 24950)
	refCE  int
	refPE  int
	qCE    float64 // option price for CE (raw units / 100)
	qPE    float64 // option price for PE (raw units / 100)
	ltpCE  float64
	ltpPE  float64
}

// fetchOrderBookMid fetches the best bid/ask midpoint for a ref_id.
// Returns 0 if unavailable (rate limit, no quote, etc.).
func (s *server) fetchOrderBookMid(ctx context.Context, baseURL, sessionToken, deviceID string, refID int) float64 {
	u := fmt.Sprintf("%s/orderbooks/%d?levels=1", baseURL, refID)
	payload, status, err := s.nubraJSON(ctx, http.MethodGet, u, map[string]string{
		"Authorization": "Bearer " + sessionToken,
		"x-device-id":   deviceID,
	}, nil)
	if err != nil || status >= 400 {
		return 0
	}
	ob, _ := payload["orderBook"].(map[string]any)
	if ob == nil {
		return 0
	}
	bids, _ := ob["bid"].([]any)
	asks, _ := ob["ask"].([]any)
	var bestBid, bestAsk float64
	if len(bids) > 0 {
		if b, ok := bids[0].(map[string]any); ok {
			bestBid = anyFloat(b["p"])
		}
	}
	if len(asks) > 0 {
		if a, ok := asks[0].(map[string]any); ok {
			bestAsk = anyFloat(a["p"])
		}
	}
	if bestBid > 0 && bestAsk > 0 {
		return (bestBid + bestAsk) / 2.0 / 100.0 // convert paise → rupees
	}
	return 0
}

// cboeVarianceForExpiry fetches the option chain for one expiry and computes
// the CBOE variance term σ²×T using OTM strike summation with order book bid/ask.
// Falls back to LTP when order book is unavailable.
func (s *server) cboeVarianceForExpiry(ctx context.Context, baseURL, sessionToken, deviceID, exchange, instrument, expiry string, intervalSecs int64) (tsNano int64, variance float64) {
	chainURL := baseURL + "/optionchains/" + url.PathEscape(instrument) +
		"?exchange=" + url.QueryEscape(exchange) + "&expiry=" + url.QueryEscape(expiry)
	payload, status, err := s.nubraJSON(ctx, http.MethodGet, chainURL, map[string]string{
		"Authorization": "Bearer " + sessionToken,
		"Accept":        "application/json",
		"x-device-id":   deviceID,
	}, nil)
	if err != nil || status >= 400 {
		return 0, 0
	}
	chain, _ := payload["chain"].(map[string]any)
	if chain == nil {
		return 0, 0
	}

	atm := anyFloat(chain["atm"])
	cp := anyFloat(chain["cp"])
	if cp <= 0 {
		cp = atm
	}
	if cp <= 0 || atm <= 0 {
		return 0, 0
	}
	spot := cp / 100.0 // rupees

	// Parse expiry → years to expiry
	ist := time.FixedZone("IST", 5*3600+30*60)
	now := time.Now().In(ist)
	expiryDate, ok := parseCompactDate(expiry)
	if !ok && regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`).MatchString(expiry) {
		expiryDate = expiry
		ok = true
	}
	if !ok {
		return 0, 0
	}
	exTime, err := time.ParseInLocation("2006-01-02 15:04", expiryDate+" 15:30", ist)
	if err != nil {
		return 0, 0
	}
	T := exTime.Sub(now).Seconds() / (365.0 * 24.0 * 3600.0)
	if T <= 0 {
		return 0, 0
	}

	// Build strike maps
	ceByStrike := optionRefsByStrike(chain["ce"])
	peByStrike := optionRefsByStrike(chain["pe"])
	if len(ceByStrike) == 0 || len(peByStrike) == 0 {
		return 0, 0
	}

	// Collect all shared strikes sorted ascending
	allStrikes := sharedStrikes(ceByStrike, peByStrike)
	if len(allStrikes) == 0 {
		return 0, 0
	}
	sort.Float64s(allStrikes)

	// Find K0: highest strike <= forward price (use spot as proxy for forward)
	forward := spot * 100.0 // raw units
	k0idx := 0
	for i, k := range allStrikes {
		if k <= forward {
			k0idx = i
		}
	}

	// Limit to ~60 strikes around ATM to avoid rate limit hammering
	const maxWings = 30
	startIdx := k0idx - maxWings
	endIdx := k0idx + maxWings
	if startIdx < 0 {
		startIdx = 0
	}
	if endIdx >= len(allStrikes) {
		endIdx = len(allStrikes) - 1
	}
	strikes := allStrikes[startIdx : endIdx+1]

	// Fetch order book for each strike in parallel (bounded concurrency)
	type strikeQ struct {
		strike float64
		qOTM   float64 // OTM option price in rupees
	}
	k0strike := allStrikes[k0idx] // capture once, avoid closure over k0idx
	sem := make(chan struct{}, 8)  // max 8 concurrent order book calls
	results := make([]strikeQ, len(strikes))
	var wg sync.WaitGroup
	for i, k := range strikes {
		wg.Add(1)
		go func(idx int, k float64) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			ce := ceByStrike[k]
			pe := peByStrike[k]

			var q float64
			if k == k0strike {
				// At K0: average of CE and PE
				midCE := s.fetchOrderBookMid(ctx, baseURL, sessionToken, deviceID, ce.RefID)
				midPE := s.fetchOrderBookMid(ctx, baseURL, sessionToken, deviceID, pe.RefID)
				if midCE <= 0 {
					midCE = ce.LTP / 100.0
				}
				if midPE <= 0 {
					midPE = pe.LTP / 100.0
				}
				q = (midCE + midPE) / 2.0
			} else if k > forward {
				// OTM call
				mid := s.fetchOrderBookMid(ctx, baseURL, sessionToken, deviceID, ce.RefID)
				if mid <= 0 {
					mid = ce.LTP / 100.0
				}
				q = mid
			} else {
				// OTM put
				mid := s.fetchOrderBookMid(ctx, baseURL, sessionToken, deviceID, pe.RefID)
				if mid <= 0 {
					mid = pe.LTP / 100.0
				}
				q = mid
			}
			results[idx] = strikeQ{strike: k, qOTM: q}
		}(i, k)
	}
	wg.Wait()

	// CBOE summation: σ² = (2/T) × Σ [ΔK/K²] × e^(RT) × Q(K)  −  (1/T) × [F/K0 − 1]²
	const R = 0.06 // risk-free rate
	eRT := math.Exp(R * T)
	k0Raw := allStrikes[k0idx]

	var sum float64
	for i, sq := range results {
		if sq.qOTM <= 0 {
			continue
		}
		k := sq.strike / 100.0 // rupees
		// ΔK: half distance to adjacent strikes
		var deltaK float64
		if i == 0 {
			deltaK = (results[1].strike - results[0].strike) / 100.0
		} else if i == len(results)-1 {
			deltaK = (results[len(results)-1].strike - results[len(results)-2].strike) / 100.0
		} else {
			deltaK = (results[i+1].strike - results[i-1].strike) / 2.0 / 100.0
		}
		sum += (deltaK / (k * k)) * eRT * sq.qOTM
	}
	sum *= 2.0 / T

	// Forward-price correction term
	F := spot * math.Exp(R*T)
	k0Rupees := k0Raw / 100.0
	correction := (1.0 / T) * math.Pow(F/k0Rupees-1.0, 2)
	sigmaSquared := sum - correction
	if sigmaSquared <= 0 {
		// Negative variance from correction: use raw sum (forward ≈ K0)
		sigmaSquared = sum
	}

	// Bucket to interval
	tsSeconds := (now.Unix() / intervalSecs) * intervalSecs
	return tsSeconds * int64(time.Second), sigmaSquared * T
}

func (s *server) weeklyVix(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"detail": "method not allowed"})
		return
	}
	var req weeklyVixRequest
	if err := decodeJSON(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"detail": "invalid JSON"})
		return
	}
	if req.Instrument == "" {
		req.Instrument = "NIFTY"
	}
	if req.Interval == "" {
		req.Interval = "5m"
	}

	if req.SessionToken == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"detail": "session_token required"})
		return
	}
	if req.DeviceID == "" {
		req.DeviceID = "Nubra-OSS-weekly-vix"
	}

	ist := time.FixedZone("IST", 5*3600+30*60)
	now := time.Now().In(ist)
	baseURL := nubraBaseURL(req.Environment)
	exchange := normalizeExchange(req.Exchange)

	// Fetch all expiries from Nubra option chain
	chainURL := baseURL + "/optionchains/" + url.PathEscape(req.Instrument) + "?exchange=" + url.QueryEscape(exchange)
	chainPayload, chainStatus, chainErr := s.nubraJSON(r.Context(), http.MethodGet, chainURL, map[string]string{
		"Authorization": "Bearer " + req.SessionToken,
		"Accept":        "application/json",
		"x-device-id":   req.DeviceID,
	}, nil)
	if chainErr != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"detail": "option chain error: " + chainErr.Error()})
		return
	}
	if chainStatus >= 400 {
		writeJSON(w, chainStatus, map[string]string{"detail": extractError(chainPayload, chainStatus)})
		return
	}
	chain, _ := chainPayload["chain"].(map[string]any)
	if chain == nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"detail": "unexpected option chain response"})
		return
	}

	var allExpiries []string
	for _, e := range func() []any { arr, _ := chain["all_expiries"].([]any); return arr }() {
		if es, ok := e.(string); ok && es != "" {
			allExpiries = append(allExpiries, es)
		}
	}

	// Weekly VIX uses the weekly expiry curve around the 7-day target, not
	// the NSE India VIX near/next monthly 30-day window.
	todayDate := now.Truncate(24 * time.Hour)
	type expiryCandidate struct {
		expiry string
		days   float64
	}
	var expiryCandidates []expiryCandidate
	for _, ex := range allExpiries {
		parsed, ok := parseCompactDate(ex)
		if !ok {
			continue
		}
		exTime, err := time.ParseInLocation("2006-01-02", parsed, ist)
		if err != nil {
			continue
		}
		exDate := exTime.Truncate(24 * time.Hour)
		days := exDate.Sub(todayDate).Hours() / 24.0
		if days >= 1 && days <= 21 {
			expiryCandidates = append(expiryCandidates, expiryCandidate{expiry: parsed, days: days})
		}
	}
	sort.Slice(expiryCandidates, func(i, j int) bool { return expiryCandidates[i].days < expiryCandidates[j].days })

	const targetDays = 7.0
	var filteredExpiries []string
	var nearIdx = -1
	var nextIdx = -1
	for i, candidate := range expiryCandidates {
		if candidate.days <= targetDays {
			nearIdx = i
		} else if nextIdx == -1 {
			nextIdx = i
		}
	}
	if nearIdx >= 0 {
		filteredExpiries = append(filteredExpiries, expiryCandidates[nearIdx].expiry)
	}
	if nextIdx >= 0 {
		filteredExpiries = append(filteredExpiries, expiryCandidates[nextIdx].expiry)
	}
	if len(filteredExpiries) == 0 && len(expiryCandidates) > 0 {
		filteredExpiries = append(filteredExpiries, expiryCandidates[0].expiry)
	}
	if len(filteredExpiries) == 0 {
		writeJSON(w, http.StatusBadGateway, map[string]string{"detail": "no usable weekly expiries found (need at least one expiry 1-21 days out)"})
		return
	}

	// Determine interval in seconds for bucket alignment
	intervalSecs := int64(300) // default 5m
	switch req.Interval {
	case "1m":
		intervalSecs = 60
	case "3m":
		intervalSecs = 180
	case "15m":
		intervalSecs = 900
	case "30m":
		intervalSecs = 1800
	}

	// Fetch CBOE variance for each expiry in parallel using order book bid/ask
	type expResult struct {
		T        float64
		tsNano   int64
		variance float64 // σ²×T
	}
	expResults := make([]expResult, len(filteredExpiries))
	var wg sync.WaitGroup
	for i, ex := range filteredExpiries {
		wg.Add(1)
		go func(idx int, expiry string) {
			defer wg.Done()
			exTime, _ := time.ParseInLocation("2006-01-02 15:04", expiry+" 15:30", ist)
			T := exTime.Sub(now).Seconds() / (365.0 * 24.0 * 3600.0)
			tsNano, variance := s.cboeVarianceForExpiry(r.Context(), baseURL, req.SessionToken, req.DeviceID, exchange, req.Instrument, expiry, intervalSecs)
			expResults[idx] = expResult{T: T, tsNano: tsNano, variance: variance}
		}(i, ex)
	}
	wg.Wait()

	// Sort by T ascending
	sort.Slice(expResults, func(i, j int) bool { return expResults[i].T < expResults[j].T })

	// CBOE 7-day interpolation across all valid expiries
	const T7 = 7.0 / 365.0
	const minT = 0.5 / 365.0 // ~12 hours minimum

	type tvPair struct{ T, variance float64 }
	var pairs []tvPair
	var commonTs int64
	for _, ev := range expResults {
		if ev.T < minT || ev.variance <= 0 || ev.tsNano <= 0 {
			continue
		}
		pairs = append(pairs, tvPair{ev.T, ev.variance})
		if commonTs == 0 {
			commonTs = ev.tsNano
		}
	}

	if len(pairs) == 0 || commonTs == 0 {
		writeJSON(w, http.StatusBadGateway, map[string]string{"detail": "unable to compute weekly VIX — no valid expiry data from order book"})
		return
	}

	var vix float64
	if len(pairs) == 1 {
		vix = math.Sqrt(pairs[0].variance/pairs[0].T) * 100.0
	} else {
		var near, next *tvPair
		for idx := range pairs {
			p := &pairs[idx]
			if p.T <= T7 {
				if near == nil || p.T > near.T {
					near = p
				}
			} else {
				if next == nil || p.T < next.T {
					next = p
				}
			}
		}
		if near == nil {
			vix = math.Sqrt(next.variance/next.T) * 100.0
		} else if next == nil {
			vix = math.Sqrt(near.variance/near.T) * 100.0
		} else {
			// CBOE linear interpolation: VIX² = w1×σ1²×(T1/T7) + w2×σ2²×(T2/T7)
			w1 := (next.T - T7) / (next.T - near.T)
			w2 := (T7 - near.T) / (next.T - near.T)
			varInterp := w1*near.variance + w2*next.variance
			vix = math.Sqrt(varInterp/T7) * 100.0
		}
	}

	if vix <= 0 || math.IsNaN(vix) || math.IsInf(vix, 0) {
		writeJSON(w, http.StatusBadGateway, map[string]string{"detail": "VIX computation resulted in invalid value"})
		return
	}

	points := []rollingPoint{{Ts: commonTs, Value: vix}}

	writeJSON(w, http.StatusOK, weeklyVixResponse{
		Instrument: req.Instrument,
		Exchange:   exchange,
		Points:     points,
		Latest:     vix,
		Message:    fmt.Sprintf("Weekly VIX for %s: %.2f (CBOE OTM summation, %d expiries, order book bid/ask).", req.Instrument, vix, len(pairs)),
	})
}

func (s *server) underlyingSeries(ctx context.Context, baseURL, sessionToken, deviceID, exchange, instrument, interval, start, end string) ([]rollingPoint, error) {
	body := map[string]any{
		"query": []any{map[string]any{
			"exchange":  exchange,
			"type":      "INDEX",
			"values":    []string{instrument},
			"fields":    []string{"close"},
			"startDate": start,
			"endDate":   end,
			"interval":  interval,
			"intraDay":  false,
			"realTime":  false,
		}},
	}
	payload, status, err := s.nubraJSON(ctx, http.MethodPost, baseURL+"/charts/timeseries",
		map[string]string{
			"Authorization": "Bearer " + sessionToken,
			"Content-Type":  "application/json",
			"Accept":        "application/json",
			"x-device-id":   deviceID,
		}, body)
	if err != nil {
		return nil, err
	}
	if status >= 400 {
		return nil, fmt.Errorf("%s", extractError(payload, status))
	}
	series := closeSeries(payload)
	return series[strings.ToUpper(instrument)], nil
}

func (s *server) refSymbolsByID(ctx context.Context, baseURL, sessionToken, deviceID, exchange, date string) (map[int]string, error) {
	refURL := baseURL + "/refdata/refdata/" + url.PathEscape(date) + "?exchange=" + url.QueryEscape(exchange)
	payload, status, err := s.nubraJSON(ctx, http.MethodGet, refURL, map[string]string{
		"Authorization": "Bearer " + sessionToken,
		"Accept":        "application/json",
		"x-device-id":   deviceID,
	}, nil)
	if err != nil {
		return nil, fmt.Errorf("Nubra refdata error: %w", err)
	}
	if status >= 400 {
		return nil, fmt.Errorf("%s", extractError(payload, status))
	}
	out := map[int]string{}
	rows, _ := payload["refdata"].([]any)
	for _, item := range rows {
		m, _ := item.(map[string]any)
		refID := int(anyInt64(m["ref_id"]))
		symbol := firstString(m, "stock_name", "symbol", "tradingsymbol", "display_name", "name")
		if refID > 0 && symbol != "" {
			out[refID] = symbol
		}
	}
	return out, nil
}

func (s *server) refSymbolsByIDForRefs(ctx context.Context, baseURL, sessionToken, deviceID, exchange string, dates []string, refIDs []int) (map[int]string, error) {
	wanted := map[int]bool{}
	for _, refID := range refIDs {
		if refID > 0 {
			wanted[refID] = true
		}
	}
	if len(wanted) == 0 {
		return map[int]string{}, nil
	}

	best := map[int]string{}
	bestMatches := 0
	var lastErr error
	for _, date := range dates {
		refMap, err := s.refSymbolsByID(ctx, baseURL, sessionToken, deviceID, exchange, date)
		if err != nil {
			lastErr = err
			continue
		}
		matches := 0
		for refID := range wanted {
			if refMap[refID] != "" {
				matches++
			}
		}
		if matches == len(wanted) {
			return refMap, nil
		}
		if matches > bestMatches {
			best = refMap
			bestMatches = matches
		}
	}
	if bestMatches > 0 {
		return best, nil
	}
	if lastErr != nil {
		return nil, lastErr
	}
	return nil, fmt.Errorf("selected option ref_ids were not found in refdata for checked dates: %s", strings.Join(dates, ", "))
}

func refDateCandidates(requested, expiry string) []string {
	seen := map[string]bool{}
	var dates []string
	add := func(date string) {
		date = strings.TrimSpace(date)
		if date == "" {
			return
		}
		if parsed, ok := parseCompactDate(date); ok {
			date = parsed
		}
		if !seen[date] {
			seen[date] = true
			dates = append(dates, date)
		}
	}

	add(requested)
	now := time.Now().In(time.FixedZone("IST", 5*3600+30*60))
	add(now.Format("2006-01-02"))
	for i := 1; i <= 10; i++ {
		add(now.AddDate(0, 0, -i).Format("2006-01-02"))
	}
	add(expiry)
	return dates
}

func parseCompactDate(value string) (string, bool) {
	if !regexp.MustCompile(`^\d{8}$`).MatchString(value) {
		return "", false
	}
	parsed, err := time.Parse("20060102", value)
	if err != nil {
		return "", false
	}
	return parsed.Format("2006-01-02"), true
}

func optionRefIDsForStrikes(strikes []float64, customMode bool, ceByStrike, peByStrike map[float64]optionRef) []int {
	seen := map[int]bool{}
	var out []int
	add := func(refID int) {
		if refID > 0 && !seen[refID] {
			seen[refID] = true
			out = append(out, refID)
		}
	}
	if customMode && len(strikes) >= 2 {
		add(ceByStrike[strikes[0]].RefID)
		add(peByStrike[strikes[1]].RefID)
		return out
	}
	for _, strike := range strikes {
		add(ceByStrike[strike].RefID)
		add(peByStrike[strike].RefID)
	}
	return out
}

func optionRefsByStrike(value any) map[float64]optionRef {
	out := map[float64]optionRef{}
	arr, _ := value.([]any)
	for _, item := range arr {
		m, _ := item.(map[string]any)
		strike := anyFloat(m["sp"])
		refID := int(anyInt64(m["ref_id"]))
		if strike > 0 && refID > 0 {
			out[strike] = optionRef{RefID: refID, Strike: strike, IV: anyFloat(m["iv"]), Delta: anyFloat(m["delta"]), LTP: anyFloat(m["ltp"])}
		}
	}
	return out
}

func normalizeStrikeInput(strike float64) float64 {
	if strike <= 0 {
		return 0
	}
	if strike < 100000 {
		return strike * 100.0
	}
	return strike
}

func closestDeltaOption(options map[float64]optionRef, target float64) (optionRef, bool) {
	var best optionRef
	bestDistance := 0.0
	found := false
	for _, opt := range options {
		if opt.IV <= 0 {
			continue
		}
		value := opt.Delta
		compareTarget := target
		if target < 0 {
			if value < 0 {
				value = -value
			}
			compareTarget = -target
		}
		distance := value - compareTarget
		if distance < 0 {
			distance = -distance
		}
		if !found || distance < bestDistance {
			best = opt
			bestDistance = distance
			found = true
		}
	}
	return best, found
}

func sharedStrikes(ce, pe map[float64]optionRef) []float64 {
	var strikes []float64
	for strike := range ce {
		if _, ok := pe[strike]; ok {
			strikes = append(strikes, strike)
		}
	}
	sort.Float64s(strikes)
	return strikes
}

func strikesForUnderlyingBand(allStrikes []float64, underlying []rollingPoint, fallbackATM float64, wings int) []float64 {
	selected := map[float64]bool{}
	if len(underlying) == 0 {
		for _, strike := range strikesAroundValue(allStrikes, fallbackATM, wings) {
			selected[strike] = true
		}
	} else {
		for _, point := range underlying {
			for _, strike := range strikesAroundValue(allStrikes, point.Value*100.0, wings) {
				selected[strike] = true
			}
		}
	}
	out := make([]float64, 0, len(selected))
	for strike := range selected {
		out = append(out, strike)
	}
	sort.Float64s(out)
	return out
}

func latestStrikeAnchor(underlying []rollingPoint, fallbackATM float64) float64 {
	for idx := len(underlying) - 1; idx >= 0; idx-- {
		if underlying[idx].Value > 0 {
			return underlying[idx].Value * 100.0
		}
	}
	return fallbackATM
}

func nearestStrikeCount(strikes []float64, value float64, count int) []float64 {
	if len(strikes) == 0 || count <= 0 || len(strikes) <= count {
		return strikes
	}
	atmIdx := 0
	bestDistance := math.Abs(strikes[0] - value)
	for idx, strike := range strikes[1:] {
		distance := math.Abs(strike - value)
		if distance < bestDistance {
			atmIdx = idx + 1
			bestDistance = distance
		}
	}
	start := atmIdx - count/2
	if start < 0 {
		start = 0
	}
	end := start + count
	if end > len(strikes) {
		end = len(strikes)
		start = end - count
	}
	return strikes[start:end]
}

func strikesAroundATM(ce, pe map[float64]optionRef, atm float64, wings int) []float64 {
	return strikesAroundValue(sharedStrikes(ce, pe), atm, wings)
}

func rollingIVTargetStrikes(allStrikes []float64, atm float64, ceByStrike, peByStrike map[float64]optionRef) []float64 {
	out := map[float64]bool{}
	if strike, ok := nearestStrikeRaw(allStrikes, atm); ok {
		out[strike] = true
	}
	for _, strike := range nearestDeltaStrikes(ceByStrike, 0.25, 0.10) {
		out[strike] = true
	}
	for _, strike := range nearestDeltaStrikes(peByStrike, -0.25, -0.10) {
		out[strike] = true
	}
	for strike := range out {
		for _, nearby := range strikesAroundValue(allStrikes, strike, 1) {
			out[nearby] = true
		}
	}
	strikes := make([]float64, 0, len(out))
	for strike := range out {
		if _, hasCE := ceByStrike[strike]; !hasCE {
			continue
		}
		if _, hasPE := peByStrike[strike]; !hasPE {
			continue
		}
		strikes = append(strikes, strike)
	}
	sort.Float64s(strikes)
	return strikes
}

func nearestDeltaStrikes(refs map[float64]optionRef, targets ...float64) []float64 {
	out := make([]float64, 0, len(targets))
	for _, target := range targets {
		bestStrike := 0.0
		bestDistance := 0.0
		found := false
		for strike, ref := range refs {
			if ref.Delta == 0 || ref.IV <= 0 {
				continue
			}
			distance := math.Abs(ref.Delta - target)
			if !found || distance < bestDistance {
				bestStrike = strike
				bestDistance = distance
				found = true
			}
		}
		if found {
			out = append(out, bestStrike)
		}
	}
	return out
}

func strikesAroundValue(strikes []float64, value float64, wings int) []float64 {
	if len(strikes) == 0 {
		return nil
	}

	atmIdx := 0
	bestDistance := strikes[0] - value
	if bestDistance < 0 {
		bestDistance = -bestDistance
	}
	for idx, strike := range strikes[1:] {
		distance := strike - value
		if distance < 0 {
			distance = -distance
		}
		if distance < bestDistance {
			atmIdx = idx + 1
			bestDistance = distance
		}
	}

	start := atmIdx - wings
	if start < 0 {
		start = 0
	}
	end := atmIdx + wings + 1
	if end > len(strikes) {
		end = len(strikes)
	}
	return strikes[start:end]
}

func closeSeries(payload map[string]any) map[string][]rollingPoint {
	return fieldSeries(payload, "close")
}

func fieldSeries(payload map[string]any, field string) map[string][]rollingPoint {
	out := map[string][]rollingPoint{}
	results, _ := payload["result"].([]any)
	for _, resultItem := range results {
		ri, _ := resultItem.(map[string]any)
		values, _ := ri["values"].([]any)
		for _, valueItem := range values {
			vm, _ := valueItem.(map[string]any)
			for symbol, rawData := range vm {
				data, _ := rawData.(map[string]any)
				fieldArr, _ := data[field].([]any)
				points := make([]rollingPoint, 0, len(fieldArr))
				for _, rawPoint := range fieldArr {
					pm, _ := rawPoint.(map[string]any)
					ts := anyInt64(pm["ts"])
					v := anyFloat(pm["v"])
					if ts > 0 {
						points = append(points, rollingPoint{Ts: ts, Value: normalizeSeriesValue(field, v)})
					}
				}
				out[strings.ToUpper(symbol)] = points
			}
		}
	}
	return out
}

func normalizeSeriesValue(field string, value float64) float64 {
	if strings.EqualFold(field, "close") {
		return value / 100.0
	}
	return value
}

func ratioSeries(numerator, denominator []rollingPoint) []rollingPoint {
	denByTs := map[int64]float64{}
	for _, point := range denominator {
		if point.Value > 0 {
			denByTs[point.Ts] = point.Value
		}
	}
	out := make([]rollingPoint, 0, len(numerator))
	for _, point := range numerator {
		if point.Value <= 0 {
			continue
		}
		den, ok := denByTs[point.Ts]
		if ok && den > 0 {
			out = append(out, rollingPoint{Ts: point.Ts, Value: point.Value / den})
		}
	}
	return out
}

func ivSkewByTimestampSpot(underlying []rollingPoint, ceByStrike, peByStrike map[float64]optionRef, currentPrice, ceAnchor, peAnchor float64) []rollingPoint {
	if len(underlying) == 0 || currentPrice <= 0 || ceAnchor <= 0 || peAnchor <= 0 {
		return nil
	}
	ceOffset := ceAnchor - currentPrice
	peOffset := peAnchor - currentPrice
	ceStrikes := strikesWithIV(ceByStrike)
	peStrikes := strikesWithIV(peByStrike)
	out := make([]rollingPoint, 0, len(underlying))
	for _, spot := range underlying {
		if spot.Value <= 0 {
			continue
		}
		spotRaw := spot.Value * 100.0
		ceStrike, ceOK := nearestStrikeRaw(ceStrikes, spotRaw+ceOffset)
		peStrike, peOK := nearestStrikeRaw(peStrikes, spotRaw+peOffset)
		if !ceOK || !peOK {
			continue
		}
		ce := ceByStrike[ceStrike]
		pe := peByStrike[peStrike]
		if ce.IV > 0 && pe.IV > 0 {
			out = append(out, rollingPoint{Ts: spot.Ts, Value: ce.IV / pe.IV})
		}
	}
	return out
}

func strikesWithIV(options map[float64]optionRef) []float64 {
	out := make([]float64, 0, len(options))
	for strike, opt := range options {
		if opt.IV > 0 {
			out = append(out, strike)
		}
	}
	sort.Float64s(out)
	return out
}

func nearestStrikeRaw(strikes []float64, value float64) (float64, bool) {
	if len(strikes) == 0 {
		return 0, false
	}
	best := strikes[0]
	bestDistance := best - value
	if bestDistance < 0 {
		bestDistance = -bestDistance
	}
	for _, strike := range strikes[1:] {
		distance := strike - value
		if distance < 0 {
			distance = -distance
		}
		if distance < bestDistance {
			best = strike
			bestDistance = distance
		}
	}
	return best, true
}

func sumSeries(ce, pe []rollingPoint) []rollingPoint {
	peByTs := map[int64]float64{}
	for _, point := range pe {
		peByTs[point.Ts] = point.Value
	}
	out := make([]rollingPoint, 0, len(ce))
	for _, point := range ce {
		if peValue, ok := peByTs[point.Ts]; ok {
			out = append(out, rollingPoint{Ts: point.Ts, Value: point.Value + peValue})
		}
	}
	return out
}

func averageSeries(left, right []rollingPoint) []rollingPoint {
	rightByTs := map[int64]float64{}
	for _, point := range right {
		if point.Value > 0 {
			rightByTs[point.Ts] = point.Value
		}
	}
	out := make([]rollingPoint, 0, len(left))
	for _, point := range left {
		if point.Value <= 0 {
			continue
		}
		if rightValue, ok := rightByTs[point.Ts]; ok && rightValue > 0 {
			out = append(out, rollingPoint{Ts: point.Ts, Value: (point.Value + rightValue) / 2.0})
		}
	}
	return out
}

func rollingATMIVLeg(label string, underlying []rollingPoint, strikes []float64, ceCandidates, peCandidates []rollingIVCandidate) rollingIVLeg {
	ceByStrike := map[float64]rollingIVCandidate{}
	peByStrike := map[float64]rollingIVCandidate{}
	for _, candidate := range ceCandidates {
		ceByStrike[candidate.Strike] = candidate
	}
	for _, candidate := range peCandidates {
		peByStrike[candidate.Strike] = candidate
	}
	var points []rollingPoint
	var latest rollingIVLeg
	latest.Label = label
	for _, spot := range underlying {
		if spot.Value <= 0 {
			continue
		}
		strike, ok := nearestStrikeRaw(strikes, spot.Value*100.0)
		if !ok {
			continue
		}
		ce := ceByStrike[strike]
		pe := peByStrike[strike]
		ceIV := ce.IVByTs[spot.Ts]
		peIV := pe.IVByTs[spot.Ts]
		if ceIV <= 0 || peIV <= 0 {
			continue
		}
		value := (ceIV + peIV) / 2.0
		points = append(points, rollingPoint{Ts: spot.Ts, Value: value})
		latest = rollingIVLeg{
			Label:  label,
			Strike: strike / 100.0,
			Symbol: ce.Symbol + " / " + pe.Symbol,
			RefID:  ce.RefID,
			IV:     value,
			Delta:  0,
		}
	}
	latest.Points = points
	return latest
}

func rollingDeltaIVLeg(label string, targetDelta float64, underlying []rollingPoint, candidates []rollingIVCandidate, expiry string) rollingIVLeg {
	var points []rollingPoint
	var latest rollingIVLeg
	latest.Label = label
	for _, spot := range underlying {
		if spot.Value <= 0 {
			continue
		}
		years := yearsToExpiry(spot.Ts, expiry)
		if years <= 0 {
			continue
		}
		var best rollingIVCandidate
		bestIV := 0.0
		bestDelta := 0.0
		bestDistance := 0.0
		found := false
		for _, candidate := range candidates {
			ivPercent := candidate.IVByTs[spot.Ts]
			if ivPercent <= 0 {
				continue
			}
			delta, ok := blackScholesDelta(spot.Value, candidate.Strike/100.0, years, 0.06, ivPercent/100.0, candidate.IsCall)
			if !ok {
				continue
			}
			distance := math.Abs(delta - targetDelta)
			if !found || distance < bestDistance {
				best = candidate
				bestIV = ivPercent
				bestDelta = delta
				bestDistance = distance
				found = true
			}
		}
		if !found {
			continue
		}
		points = append(points, rollingPoint{Ts: spot.Ts, Value: bestIV})
		latest = rollingIVLeg{
			Label:  label,
			Strike: best.Strike / 100.0,
			Symbol: best.Symbol,
			RefID:  best.RefID,
			IV:     bestIV,
			Delta:  bestDelta,
		}
	}
	latest.Points = points
	return latest
}

func optionIVSeries(prices, historicalIV, underlying []rollingPoint, strike float64, expiry string, isCall bool) []rollingPoint {
	ivByTs := pointsByTs(historicalIV)
	spotByTs := pointsByTs(underlying)
	out := make([]rollingPoint, 0, len(prices))
	for _, price := range prices {
		if iv := ivByTs[price.Ts]; iv > 0 {
			out = append(out, rollingPoint{Ts: price.Ts, Value: iv})
			continue
		}
		spot := spotByTs[price.Ts]
		if spot <= 0 || price.Value <= 0 || strike <= 0 {
			continue
		}
		years := yearsToExpiry(price.Ts, expiry)
		if years <= 0 {
			continue
		}
		iv, ok := impliedVolatility(price.Value, spot, strike, years, 0.06, isCall)
		if ok {
			out = append(out, rollingPoint{Ts: price.Ts, Value: iv * 100.0})
		}
	}
	if len(out) > 0 {
		return out
	}
	return historicalIV
}

func yearsToExpiry(ts int64, expiry string) float64 {
	if ts <= 0 {
		return 0
	}
	expiryDate, ok := parseCompactDate(expiry)
	if !ok {
		return 0
	}
	expiryTime, err := time.ParseInLocation("2006-01-02 15:04", expiryDate+" 15:30", time.FixedZone("IST", 5*3600+30*60))
	if err != nil {
		return 0
	}
	seconds := expiryTime.Unix() - ts/1_000_000_000
	if seconds <= 0 {
		return 0
	}
	return float64(seconds) / (365.0 * 24.0 * 60.0 * 60.0)
}

func yearsToExpiryDate(ts int64, expiryDate string) float64 {
	if ts <= 0 || !regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`).MatchString(expiryDate) {
		return 0
	}
	expiryTime, err := time.ParseInLocation("2006-01-02 15:04", expiryDate+" 15:30", time.FixedZone("IST", 5*3600+30*60))
	if err != nil {
		return 0
	}
	seconds := expiryTime.Unix() - ts/1_000_000_000
	if seconds <= 0 {
		return 0
	}
	return float64(seconds) / (365.0 * 24.0 * 60.0 * 60.0)
}

func impliedVolatility(optionPrice, spot, strike, years, rate float64, isCall bool) (float64, bool) {
	intrinsic := 0.0
	if isCall {
		intrinsic = math.Max(spot-strike, 0)
	} else {
		intrinsic = math.Max(strike-spot, 0)
	}
	if optionPrice < intrinsic || optionPrice <= 0 || spot <= 0 || strike <= 0 || years <= 0 {
		return 0, false
	}

	low := 0.0001
	high := 5.0
	for i := 0; i < 80; i++ {
		mid := (low + high) / 2.0
		price := blackScholesPrice(spot, strike, years, rate, mid, isCall)
		if math.IsNaN(price) || math.IsInf(price, 0) {
			return 0, false
		}
		if price > optionPrice {
			high = mid
		} else {
			low = mid
		}
	}
	iv := (low + high) / 2.0
	if iv <= 0 {
		return 0, false
	}
	return iv, true
}

func blackScholesPrice(spot, strike, years, rate, volatility float64, isCall bool) float64 {
	if spot <= 0 || strike <= 0 || years <= 0 || volatility <= 0 {
		return 0
	}
	sqrtT := math.Sqrt(years)
	d1 := (math.Log(spot/strike) + (rate+0.5*volatility*volatility)*years) / (volatility * sqrtT)
	d2 := d1 - volatility*sqrtT
	discountedStrike := strike * math.Exp(-rate*years)
	if isCall {
		return spot*normalCDF(d1) - discountedStrike*normalCDF(d2)
	}
	return discountedStrike*normalCDF(-d2) - spot*normalCDF(-d1)
}

func blackScholesDelta(spot, strike, years, rate, volatility float64, isCall bool) (float64, bool) {
	if spot <= 0 || strike <= 0 || years <= 0 || volatility <= 0 {
		return 0, false
	}
	sqrtT := math.Sqrt(years)
	d1 := (math.Log(spot/strike) + (rate+0.5*volatility*volatility)*years) / (volatility * sqrtT)
	if math.IsNaN(d1) || math.IsInf(d1, 0) {
		return 0, false
	}
	if isCall {
		return normalCDF(d1), true
	}
	return normalCDF(d1) - 1.0, true
}

func normalCDF(value float64) float64 {
	return 0.5 * (1.0 + math.Erf(value/math.Sqrt2))
}

func syntheticFutureSeries(strikes []float64, ceByStrike, peByStrike map[float64]optionRef, candles map[string][]rollingPoint, underlying []rollingPoint, fallbackATM float64) []rollingPoint {
	if len(strikes) == 0 {
		return nil
	}
	sort.Float64s(strikes)

	points := underlying
	hasUnderlying := len(points) > 0
	if !hasUnderlying {
		atmStrike := strikesAroundValue(strikes, fallbackATM, 0)
		if len(atmStrike) == 0 {
			return nil
		}
		ce := ceByStrike[atmStrike[0]]
		points = candles[ce.Symbol]
	}

	out := make([]rollingPoint, 0, len(points))
	for _, spot := range points {
		valueForATM := fallbackATM
		if hasUnderlying && spot.Value > 0 {
			valueForATM = spot.Value * 100.0
		}
		if valueForATM <= 0 {
			valueForATM = fallbackATM
		}
		atmStrike := strikesAroundValue(strikes, valueForATM, 0)
		if len(atmStrike) == 0 {
			continue
		}
		strike := atmStrike[0]
		ce := ceByStrike[strike]
		pe := peByStrike[strike]
		ceByTs := pointsByTs(candles[ce.Symbol])
		peByTs := pointsByTs(candles[pe.Symbol])
		ceValue, ceOK := ceByTs[spot.Ts]
		peValue, peOK := peByTs[spot.Ts]
		if ceOK && peOK {
			out = append(out, rollingPoint{Ts: spot.Ts, Value: strike/100.0 + ceValue - peValue})
		}
	}
	return out
}

func pointsByTs(points []rollingPoint) map[int64]float64 {
	out := make(map[int64]float64, len(points))
	for _, point := range points {
		out[point.Ts] = point.Value
	}
	return out
}

func rollingByLowestPremium(series []straddleSeries) []rollingPoint {
	bestByTs := map[int64]float64{}
	for _, item := range series {
		for _, point := range item.Points {
			current, ok := bestByTs[point.Ts]
			if !ok || point.Value < current {
				bestByTs[point.Ts] = point.Value
			}
		}
	}
	timestamps := make([]int64, 0, len(bestByTs))
	for ts := range bestByTs {
		timestamps = append(timestamps, ts)
	}
	sort.Slice(timestamps, func(i, j int) bool { return timestamps[i] < timestamps[j] })
	out := make([]rollingPoint, 0, len(timestamps))
	for _, ts := range timestamps {
		out = append(out, rollingPoint{Ts: ts, Value: bestByTs[ts]})
	}
	return out
}

func rollingByLowestIV(series []straddleSeries) []rollingPoint {
	bestPremiumByTs := map[int64]float64{}
	bestIVByTs := map[int64]float64{}
	for _, item := range series {
		ivByTs := pointsByTs(item.IVPoints)
		for _, point := range item.Points {
			current, ok := bestPremiumByTs[point.Ts]
			if !ok || point.Value < current {
				bestPremiumByTs[point.Ts] = point.Value
				bestIVByTs[point.Ts] = ivByTs[point.Ts]
			}
		}
	}
	timestamps := make([]int64, 0, len(bestIVByTs))
	for ts, value := range bestIVByTs {
		if value > 0 {
			timestamps = append(timestamps, ts)
		}
	}
	sort.Slice(timestamps, func(i, j int) bool { return timestamps[i] < timestamps[j] })
	out := make([]rollingPoint, 0, len(timestamps))
	for _, ts := range timestamps {
		out = append(out, rollingPoint{Ts: ts, Value: bestIVByTs[ts]})
	}
	return out
}

func rollingByTimestampATM(series []straddleSeries, underlying []rollingPoint, fallbackATM float64, wings int) []rollingPoint {
	if len(underlying) == 0 {
		return rollingByLowestPremium(series)
	}
	byStrike := map[float64]straddleSeries{}
	for _, item := range series {
		byStrike[item.Strike] = item
	}
	var strikes []float64
	for strike := range byStrike {
		strikes = append(strikes, strike)
	}
	sort.Float64s(strikes)

	underlyingByTs := map[int64]float64{}
	for _, point := range underlying {
		underlyingByTs[point.Ts] = point.Value
	}
	bestByTs := map[int64]float64{}
	for _, item := range series {
		for _, point := range item.Points {
			underlyingValue, ok := underlyingByTs[point.Ts]
			if !ok {
				underlyingValue = fallbackATM
			}
			allowed := strikesAroundValue(strikes, underlyingValue, wings)
			if !containsStrike(allowed, item.Strike) {
				continue
			}
			current, exists := bestByTs[point.Ts]
			if !exists || point.Value < current {
				bestByTs[point.Ts] = point.Value
			}
		}
	}
	timestamps := make([]int64, 0, len(bestByTs))
	for ts := range bestByTs {
		timestamps = append(timestamps, ts)
	}
	sort.Slice(timestamps, func(i, j int) bool { return timestamps[i] < timestamps[j] })
	out := make([]rollingPoint, 0, len(timestamps))
	for _, ts := range timestamps {
		out = append(out, rollingPoint{Ts: ts, Value: bestByTs[ts]})
	}
	return out
}

func rollingIVByTimestampATM(series []straddleSeries, underlying []rollingPoint, fallbackATM float64, wings int) ([]rollingPoint, []rollingPoint, []rollingPoint) {
	if len(underlying) == 0 {
		return rollingByLowestIV(series), nil, nil
	}
	byStrike := map[float64]straddleSeries{}
	for _, item := range series {
		byStrike[item.Strike] = item
	}
	var strikes []float64
	for strike := range byStrike {
		strikes = append(strikes, strike)
	}
	sort.Float64s(strikes)

	underlyingByTs := map[int64]float64{}
	for _, point := range underlying {
		underlyingByTs[point.Ts] = point.Value
	}
	bestPremiumByTs := map[int64]float64{}
	bestIVByTs := map[int64]float64{}
	bestCEIVByTs := map[int64]float64{}
	bestPEIVByTs := map[int64]float64{}
	for _, item := range series {
		ivByTs := pointsByTs(item.IVPoints)
		ceIVByTs := pointsByTs(item.CEIVPoints)
		peIVByTs := pointsByTs(item.PEIVPoints)
		for _, point := range item.Points {
			underlyingValue, ok := underlyingByTs[point.Ts]
			if !ok {
				underlyingValue = fallbackATM
			}
			allowed := strikesAroundValue(strikes, underlyingValue, wings)
			if !containsStrike(allowed, item.Strike) {
				continue
			}
			current, exists := bestPremiumByTs[point.Ts]
			if !exists || point.Value < current {
				bestPremiumByTs[point.Ts] = point.Value
				bestIVByTs[point.Ts] = ivByTs[point.Ts]
				bestCEIVByTs[point.Ts] = ceIVByTs[point.Ts]
				bestPEIVByTs[point.Ts] = peIVByTs[point.Ts]
			}
		}
	}
	return pointsFromMap(bestIVByTs), pointsFromMap(bestCEIVByTs), pointsFromMap(bestPEIVByTs)
}

func pointsFromMap(values map[int64]float64) []rollingPoint {
	timestamps := make([]int64, 0, len(values))
	for ts, value := range values {
		if value > 0 {
			timestamps = append(timestamps, ts)
		}
	}
	sort.Slice(timestamps, func(i, j int) bool { return timestamps[i] < timestamps[j] })
	out := make([]rollingPoint, 0, len(timestamps))
	for _, ts := range timestamps {
		out = append(out, rollingPoint{Ts: ts, Value: values[ts]})
	}
	return out
}

func containsStrike(strikes []float64, needle float64) bool {
	for _, strike := range strikes {
		if strike == needle {
			return true
		}
	}
	return false
}

func rollingStraddleMessage(strikeCount int, underlyingErr error) string {
	if underlyingErr != nil {
		return fmt.Sprintf("Loaded %d strikes using current ATM fallback because underlying history was unavailable: %s", strikeCount, underlyingErr.Error())
	}
	return fmt.Sprintf("Loaded timestamp-wise rolling straddle across %d strikes. ATM is recalculated from underlying candles and ATM +/- 5 is evaluated at each timestamp.", strikeCount)
}

func rollingIVMessage(message string, ivFallbackUsed bool) string {
	if ivFallbackUsed {
		return message + " IV line uses current option-chain IV because historical IV was unavailable from Nubra."
	}
	return message + " IV line uses historical IV for the same selected CE/PE legs."
}

func anyFloat(value any) float64 {
	switch v := value.(type) {
	case float64:
		return v
	case int:
		return float64(v)
	case int64:
		return float64(v)
	case json.Number:
		f, _ := v.Float64()
		return f
	case string:
		f, _ := strconv.ParseFloat(strings.TrimSpace(v), 64)
		return f
	default:
		return 0
	}
}

func anyInt64(value any) int64 {
	switch v := value.(type) {
	case float64:
		return int64(v)
	case int:
		return int64(v)
	case int64:
		return v
	case json.Number:
		n, _ := v.Int64()
		return n
	case string:
		n, _ := strconv.ParseInt(strings.TrimSpace(v), 10, 64)
		return n
	default:
		return 0
	}
}

func firstString(values map[string]any, keys ...string) string {
	for _, key := range keys {
		if value, ok := values[key].(string); ok && strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

type ivRankRequest struct {
	SessionToken string `json:"session_token"`
	DeviceID     string `json:"device_id"`
	Environment  string `json:"environment"`
	Exchange     string `json:"exchange"`
	Instrument   string `json:"instrument"`
	Expiry       string `json:"expiry"`
}

type ivRankResponse struct {
	Instrument string  `json:"instrument"`
	Exchange   string  `json:"exchange"`
	IVRank     float64 `json:"iv_rank"`    // 0–100
	IVPercent  float64 `json:"iv_percent"` // current ATM IV as %
	IVHigh52   float64 `json:"iv_high_52"`
	IVLow52    float64 `json:"iv_low_52"`
	Message    string  `json:"message"`
}

func (s *server) ivRank(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"detail": "method not allowed"})
		return
	}
	var req ivRankRequest
	if err := decodeJSON(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"detail": "invalid JSON"})
		return
	}
	if req.SessionToken == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"detail": "session_token required"})
		return
	}
	if req.DeviceID == "" {
		req.DeviceID = "Nubra-OSS-desk"
	}
	if req.Instrument == "" {
		req.Instrument = "NIFTY"
	}

	baseURL := nubraBaseURL(req.Environment)
	exchange := normalizeExchange(req.Exchange)

	// Step 1: get current ATM IV from the option chain snapshot.
	chainURL := baseURL + "/optionchains/" + url.PathEscape(req.Instrument) + "?exchange=" + url.QueryEscape(exchange)
	if req.Expiry != "" {
		chainURL += "&expiry=" + url.QueryEscape(req.Expiry)
	}
	chainPayload, status, err := s.nubraJSON(r.Context(), http.MethodGet, chainURL, map[string]string{
		"Authorization": "Bearer " + req.SessionToken,
		"Accept":        "application/json",
		"x-device-id":   req.DeviceID,
	}, nil)
	if err != nil || status >= 400 {
		writeJSON(w, http.StatusBadGateway, map[string]string{"detail": "option chain fetch failed"})
		return
	}

	chain, _ := chainPayload["chain"].(map[string]any)
	atm, _ := chain["atm"].(float64)
	ceArr, _ := chain["ce"].([]any)
	peArr, _ := chain["pe"].([]any)

	// Find ATM CE and PE IV.
	currentIV := 0.0
	findATMIV := func(arr []any) float64 {
		for _, item := range arr {
			m, ok := item.(map[string]any)
			if !ok {
				continue
			}
			sp, _ := m["sp"].(float64)
			if sp == atm {
				iv, _ := m["iv"].(float64)
				return iv
			}
		}
		return 0
	}
	ceIV := findATMIV(ceArr)
	peIV := findATMIV(peArr)
	if ceIV > 0 && peIV > 0 {
		currentIV = (ceIV + peIV) / 2.0
	} else if ceIV > 0 {
		currentIV = ceIV
	} else {
		currentIV = peIV
	}

	// Step 2: fetch 1-year daily option history to compute 52-week IV high/low.
	// We use ATM CE symbol constructed from option chain or fall back to NIFTY index history.
	// Use index IV_MID from historical data as proxy (1d interval, 1 year).
	now := time.Now().UTC()
	histStart := now.AddDate(-1, 0, 0).Format("2006-01-02") + "T03:30:00.000Z"
	histEnd := now.Format("2006-01-02T15:04:05.000Z")

	// Use iv_mid on the index as a 52-week IV proxy.
	histBody := map[string]any{
		"query": []any{
			map[string]any{
				"exchange":  exchange,
				"type":      "INDEX",
				"values":    []string{req.Instrument},
				"fields":    []string{"iv_mid"},
				"startDate": histStart,
				"endDate":   histEnd,
				"interval":  "1d",
				"intraDay":  false,
				"realTime":  false,
			},
		},
	}
	histPayload, histStatus, histErr := s.nubraJSON(r.Context(), http.MethodPost, baseURL+"/charts/timeseries",
		map[string]string{
			"Authorization": "Bearer " + req.SessionToken,
			"Content-Type":  "application/json",
			"Accept":        "application/json",
			"x-device-id":   req.DeviceID,
		}, histBody)

	ivHigh, ivLow, ivRankVal := 0.0, 0.0, 0.0
	msg := "IV Rank computed from 52-week daily IV history."

	if histErr == nil && histStatus < 400 {
		results, _ := histPayload["result"].([]any)
		var ivSeries []float64
		for _, ri := range results {
			rim, _ := ri.(map[string]any)
			vals, _ := rim["values"].([]any)
			for _, ve := range vals {
				vem, _ := ve.(map[string]any)
				for _, symData := range vem {
					sdm, _ := symData.(map[string]any)
					ivMidArr, _ := sdm["iv_mid"].([]any)
					for _, pt := range ivMidArr {
						ptm, _ := pt.(map[string]any)
						v, _ := ptm["v"].(float64)
						if v > 0 {
							ivSeries = append(ivSeries, v)
						}
					}
				}
			}
		}
		if len(ivSeries) > 0 {
			ivHigh = ivSeries[0]
			ivLow = ivSeries[0]
			for _, v := range ivSeries {
				if v > ivHigh {
					ivHigh = v
				}
				if v < ivLow {
					ivLow = v
				}
			}
			if ivHigh > ivLow && currentIV > 0 {
				ivRankVal = (currentIV - ivLow) / (ivHigh - ivLow) * 100.0
			}
		} else {
			msg = "IV history returned no data — rank estimated from current IV only."
		}
	} else {
		msg = "IV history unavailable — showing current IV only."
	}

	writeJSON(w, http.StatusOK, ivRankResponse{
		Instrument: req.Instrument,
		Exchange:   exchange,
		IVRank:     ivRankVal,
		IVPercent:  currentIV * 100.0,
		IVHigh52:   ivHigh * 100.0,
		IVLow52:    ivLow * 100.0,
		Message:    msg,
	})
}

func isAllowedOrigin(origin string) bool {
	if origin == "" {
		return false
	}
	return origin == "http://localhost:8888" ||
		origin == "http://127.0.0.1:8888" ||
		origin == "http://localhost:8891" ||
		origin == "http://127.0.0.1:8891" ||
		origin == "http://localhost:5173" ||
		origin == "http://127.0.0.1:5173"
}
