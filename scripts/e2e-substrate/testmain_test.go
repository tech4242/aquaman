package aquamanprovider

import (
	"os"
	"testing"

	"go.ate.dev/substrate/internal/e2e"
)

func TestMain(m *testing.M) { os.Exit(e2e.RunTestMain(m)) }
